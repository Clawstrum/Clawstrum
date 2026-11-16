"""Voice note -> text, for src/voice.ts. Parakeet TDT 0.6b v2 (int8) through sherpa-onnx, on CPU.

transcribe.py <audio> [--asr-dir DIR] [--words FILE ...] [--notes FILE ...] [--score 1.0]
Prints one JSON line: text, duration_s, load_s, decode_s, chunks, boosted (words in the boost list),
marked (sound-alikes marked in the text).

Boost list = the --words files in order, then terms mined from the --notes files: words Whisper's vocabulary has no
single token for (rare to speech models) that appear >= 3 times. A 'heard -> meant' line boosts meant and turns each
heard in the transcript into 'heard [meant?]'; later files win. Install with scripts/install-voice.sh.
"""
import argparse, collections, json, os, re, sys, tempfile, time

SR = 16000
MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
WORD = re.compile(r"(?<![\w/.`-])([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ-]{2,}[A-Za-z])(?![\w/`'])")
# frequent in notes, never what anyone says aloud
STOP = {'arxiv', 'doi', 'regex', 'configs', 'readme', 'chars', 'msgs', 'tbd', 'crossref', 'preprint', 'verbatim'}
ARROW = re.compile(r'\s*(?:->|→)\s*')


def load_audio(path):
    """decode any container to 16 kHz mono float32"""
    import av
    import numpy as np
    out = []
    with av.open(path) as f:
        rs = av.AudioResampler(format='flt', layout='mono', rate=SR)
        for frame in f.decode(audio=0):
            for r in rs.resample(frame):
                out.append(r.to_ndarray().reshape(-1))
        for r in rs.resample(None):
            out.append(r.to_ndarray().reshape(-1))
    return np.concatenate(out).astype(np.float32) if out else np.zeros(0, np.float32)


def chunks(x, lo, hi):
    """cut long audio at the quietest 100 ms between lo and hi seconds, so memory and time stay linear"""
    import numpy as np
    if len(x) <= hi * SR:
        return [x]
    win = SR // 10
    out, start = [], 0
    while len(x) - start > hi * SR:
        a, b = start + int(lo * SR), start + int(hi * SR)
        seg = x[a:b][: (b - a) // win * win].reshape(-1, win)
        cut = a + int(np.argmin((seg ** 2).mean(1))) * win + win // 2
        out.append(x[start:cut])
        start = cut
    out.append(x[start:])
    return out


def curated(path):
    if not path or not os.path.exists(path):
        return []
    return [l.strip() for l in open(path, errors='ignore') if l.strip() and not l.startswith('#')]


def mined(asr, notes, n):
    vocab_path = os.path.join(asr, 'whisper-vocab.txt')
    if not notes or not os.path.exists(vocab_path):
        return []
    common = set(l.rstrip('\n').lower() for l in open(vocab_path, errors='ignore'))
    c = collections.Counter()
    for p in notes:
        if not os.path.exists(p):
            continue
        txt = open(p, errors='ignore').read()
        txt = re.sub(r'```.*?```', ' ', txt, flags=re.S)
        txt = re.sub(r'\S*[/_=@]\S*', ' ', txt)
        for m in WORD.finditer(txt):
            c[m.group(1)] += 1
    by = collections.defaultdict(collections.Counter)
    for w, k in c.items():
        by[w.lower()][w] += k
    ranked = []
    for low, vs in by.items():
        if low in common or low in STOP or low.count('-') > 1:
            continue
        tot = sum(vs.values())
        if tot >= 3:
            ranked.append((tot, vs.most_common(1)[0][0]))
    ranked.sort(reverse=True)
    return [w for _, w in ranked[:n]]


def word_lists(asr, files, notes, n_mined=120):
    """(boost list, [(heard, meant)]). Later files win a 'heard -> meant' pair."""
    seen, out, pairs, lines = set(), [], {}, []
    for line in [w for f in files for w in curated(f)]:
        parts = ARROW.split(line, maxsplit=1)
        if len(parts) == 2:
            # only short word pairs; a sentence with an arrow in it is not a correction
            if all(re.fullmatch(r"[\w .'-]{1,40}", s) for s in parts):
                pairs[parts[0].lower()] = (parts[0], parts[1])
                lines.append(parts[1])
        else:
            lines.append(line)
    for w in lines + mined(asr, notes, n_mined):
        if w.lower() not in seen:
            seen.add(w.lower())
            out.append(w)
    return out, list(pairs.values())


def mark_soundalikes(text, pairs):
    """'Jeff' -> 'Jeff [Jev?]'. Boosting does not beat a common word that sounds the same, and the heard word can be
    meant too, so mark instead of replacing."""
    n = 0
    for heard, meant in sorted(pairs, key=lambda p: -len(p[0])):
        if heard.lower() == meant.lower():
            continue
        pat = re.compile(r'(?<![\w-])' + r'\s+'.join(map(re.escape, heard.split())) + r'(?![\w-])(?!\s*\[)', re.I)
        text, k = pat.subn(lambda m: f'{m.group(0)} [{meant}?]', text)
        n += k
    return text, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('audio')
    ap.add_argument('--asr-dir', default=os.environ.get('ASR_DIR') or os.path.expanduser('~/.clawstrum/asr'))
    ap.add_argument('--words', action='append', default=[])
    ap.add_argument('--notes', action='append', default=[])
    # shorter pieces made long notes slower and less accurate; one 255 s piece took 3.1 GB ⇒ cut only past 2 min
    ap.add_argument('--max-chunk', type=float, default=120.0, help='seconds; longer audio is cut at quiet points')
    ap.add_argument('--score', type=float, default=1.0)  # 1.5+ started rewriting ordinary words
    a = ap.parse_args()

    asr = a.asr_dir
    sys.path.insert(0, os.path.join(asr, 'py'))
    import sherpa_onnx
    model = os.path.join(asr, 'models', MODEL_NAME)

    t0 = time.time()
    x = load_audio(a.audio)
    words, pairs = word_lists(asr, a.words, a.notes)
    threads = max(1, min(4, len(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else os.cpu_count() or 1))
    kw = dict(encoder=f'{model}/encoder.int8.onnx', decoder=f'{model}/decoder.int8.onnx',
              joiner=f'{model}/joiner.int8.onnx', tokens=f'{model}/tokens.txt', num_threads=threads,
              model_type='nemo_transducer')
    tmp = None
    if words:
        tmp = tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False)
        tmp.write('\n'.join(words) + '\n')
        tmp.close()
        kw.update(decoding_method='modified_beam_search', max_active_paths=4, hotwords_file=tmp.name,
                  hotwords_score=a.score, modeling_unit='bpe', bpe_vocab=os.path.join(asr, 'bpe.vocab'))
    else:
        kw.update(decoding_method='greedy_search')
    try:
        rec = sherpa_onnx.OfflineRecognizer.from_transducer(**kw)
        t1 = time.time()
        parts = []
        for c in chunks(x, lo=0.75 * a.max_chunk, hi=a.max_chunk):
            s = rec.create_stream()
            s.accept_waveform(SR, c)
            rec.decode_stream(s)
            parts.append(s.result.text.strip())
    finally:
        if tmp:
            os.unlink(tmp.name)
    text, marked = mark_soundalikes(' '.join(p for p in parts if p), pairs)
    print(json.dumps({'text': text, 'duration_s': round(len(x) / SR, 1),
                      'load_s': round(t1 - t0, 1), 'decode_s': round(time.time() - t1, 1),
                      'chunks': len(parts), 'boosted': len(words), 'marked': marked}, ensure_ascii=False))


if __name__ == '__main__':
    main()
