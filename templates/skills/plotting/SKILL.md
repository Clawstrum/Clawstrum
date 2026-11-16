---
name: plotting
description: Produce figures against one shared per-project style, and check the generating code for the mistakes that only surface once the figure is looked at.
triggers: plot, plotting, figure, matplotlib, colormap, colorbar, axis, subplot, histogram, scatter, heatmap
not_for: Asking what an existing figure shows; a number that answers the question; terminal sanity checks; sending an existing file unchanged.
examples: give me a plot of the loss curves | can you show me point clouds of the hidden states | redo figure 2 with the new runs and a shared colorbar
---

Use when the output is an artifact someone will read: a figure for a paper, a report, or a message. Skip it when a number answers the question, and skip it when the request is to interpret a figure that already exists; that is analysis, not generation.

Run `clawstrum figures lint /absolute/path/plot_script.py` on the generating code before treating a figure as finished. It reports unlabeled axes, rainbow colormaps used for sequential data, a `plt.show()` in a file that never saves, figures opened in a loop and never closed, and font sizes below eight points. Those are defects rather than preferences: on a headless node the unsaved figure is never produced at all, and the loop that never closes keeps every figure alive. The findings are advisory and the linter does not know what the figure is for.

Everything below is judgment the linter does not make.

Style belongs to the project, not to the figure and not to the conversation. Keep one style file at the project root that sets the rcParams, the palette, and the font choices, and load it before plotting; a project reachable from several conversations still has one style. A figure that needs something different uses a temporary context override for that figure alone, not an edit to the shared file. Do not override the font family, the base palette, the spine width, or the tick direction locally, because those are what make a set of figures look like one set; needing to override them repeatedly means the shared file is wrong and should be changed deliberately.

Size for the column it will sit in rather than for the screen: roughly four and a half inches wide for a single column, seven for full width, and an aspect ratio chosen by the content. Axis labels are short with the units in parentheses, so "Loss (nats)" rather than a sentence. Titles belong on slides; a paper figure is explained by its caption, and a title that survives should be a few words. Keep the legend inside the axes without a frame where it fits.

Use the palette by name so that one concept keeps one color across every figure in the project. Solid lines for the data the figure is about, dashed for a baseline or a reference, and a shaded band at low opacity for uncertainty rather than a scatter of individual replicates. Save every figure to both a raster format at print resolution and a vector format, under a name that describes the content.

A new or redone paper figure goes to reviewers in journal-referee mode on the figure itself (the `reviewers` skill) before it is pushed; a changed number or caption goes to a `checker`.

Report the figure with one sentence saying what it shows. This skill imposes no tool gate and does not require a particular directory layout.
