# Small multiples with variance

A Tableau viz extension that draws one small bar chart per region (or any field you choose), all on the same axes. Add a comparison measure, such as a target or last year, and each bar shows its variance: green above, red below. The two panels furthest below their comparison get a red outline, so you see where to look first.

Built for part 4 of The Insights Collective's AI Accelerator, "A viz extension you build yourself".

## Add it to a workbook

1. Download [small-multiples.trex](small-multiples.trex).
2. In Tableau, on a worksheet, open the Marks card's mark type list and choose **Add Extension**, then **Access Local Extensions**, and pick the file.
3. Drag fields onto the extension's tiles: a date (or category) onto **Bars**, a measure onto **Value**, a second measure onto **Compare to** (optional, such as a target or last year), and a dimension onto **Panel by**.

## For your Tableau admin

The extension is served from:

`https://vizdj.github.io/TheInsightsCollective-toolkit/extensions/small-multiples/index.html`

On Tableau Server or Cloud, add that address to the allowed extensions. It reads summary data only, not full data.

## What's in this folder

- `index.html`, `main.js`, `style.css`: the extension (plain JavaScript and SVG, no other libraries).
- `lib/`: Tableau's own Extensions API library, with its licence.
- `small-multiples.trex`: the manifest you add in Tableau.
