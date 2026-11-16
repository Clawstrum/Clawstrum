const quote = (s: string) => '"' + s.replace(/[%\\"]/g, (c) => (c === '%' ? '%%' : '\\' + c)) + '"';
const arg = (s: string) => quote(s.replace(/\$/g, '$$$$'));
function plainPaths(...values: string[]): void {
  for (const value of values)
    if (/[\x00-\x1f\x7f]/.test(value))
      throw new Error('Service paths cannot contain control characters');
}

export function serviceUnit(home: string, node: string, cli: string): string {
  plainPaths(home, node, cli);
  // WorkingDirectory is a path field, not a shell/argv field: quotes are literal.
  const cwd = home.replace(/%/g, '%%') + '/';
  return `[Unit]\nDescription=Clawstrum Discord agent\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nEnvironment=${quote(`CLAWSTRUM_HOME=${home}`)}\nEnvironment=CLAWSTRUM_SUPERVISED=1\nExecStart=${arg(node)} ${arg(cli)} start\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=30\nWorkingDirectory=${cwd}\n\n[Install]\nWantedBy=default.target`;
}

export function backupUnits(
  home: string,
  node: string,
  cli: string,
  directory: string,
  intervalSeconds = 300,
  keepLast = 12,
  keepDays = 7,
): { service: string; timer: string } {
  plainPaths(home, node, cli, directory);
  for (const [name, value] of Object.entries({ intervalSeconds, keepLast, keepDays }))
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > (name === 'intervalSeconds' ? 864000 : 10000)
    )
      throw new Error(`Invalid ${name}`);
  return {
    service: `[Unit]\nDescription=Clawstrum live database snapshot\n\n[Service]\nType=oneshot\nUMask=0077\nEnvironment=${quote(`CLAWSTRUM_HOME=${home}`)}\nExecStart=${arg(node)} ${arg(cli)} backup live ${arg(directory)} --keep-last ${keepLast} --keep-days ${keepDays}\nTimeoutStartSec=15min\nKillMode=control-group\n`,
    timer: `[Unit]\nDescription=Clawstrum database snapshot schedule\n\n[Timer]\nOnBootSec=30s\nOnUnitInactiveSec=${intervalSeconds}s\nUnit=clawstrum-backup.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export function healthUnits(
  home: string,
  node: string,
  cli: string,
  intervalSeconds = 300,
): { service: string; timer: string } {
  plainPaths(home, node, cli);
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86400)
    throw new Error('Invalid intervalSeconds');
  return {
    service: `[Unit]\nDescription=Clawstrum health check\n\n[Service]\nType=oneshot\nEnvironment=${quote(`CLAWSTRUM_HOME=${home}`)}\nExecStart=${arg(node)} ${arg(cli)} doctor --notify\nTimeoutStartSec=2min\n`,
    timer: `[Unit]\nDescription=Clawstrum health check schedule\n\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=${intervalSeconds}s\nUnit=clawstrum-health.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
}
