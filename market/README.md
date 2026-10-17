# market/ — a DSH plugin market index for this plugin

DSH ships no plugin index. To make this plugin browsable and searchable inside
DSH, publish this directory on any static host and add the index URL as a source.

Index URL for this repository (served by raw.githubusercontent.com):

```
https://raw.githubusercontent.com/shellpower96/dsh-prompt-optimizer/main/market/index.json
```

How to use it in DSH:

1. Plugins → More (beside Experimental plugins) → turn on **Custom plugin markets**
   (bundle: `@deepseek-ai/dsh-experimental-plugin-market-bundle`).
2. Open the new **Discover** tab → **Add index source** → paste the URL above.
3. Search "smart prompt" / "智能提示词"; the card installs the git source pinned to
   the commit recorded in `index.json`.

`versions[].source.commit` pins an exact published commit, so the index must be
updated (and republished) whenever a new release replaces it.
