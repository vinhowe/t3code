# This fork

`custom` is upstream `main` plus:

- vim mode, from wSedlacek's `t3/check-vi-keybindings` (pingdotgg/t3code#31242)
- configurable `list.next` / `list.previous`, from lakardion's `feat/ctrl-n-p-list-navigation` (pingdotgg/t3code#24621)
- fork fixes on top: vim `g0`/`g$` on a padded composer, and a block cursor that also fills empty lines and hides the native caret

`main` mirrors upstream. Keep `apps/desktop/package.json` at an upstream release version, so SSH environments download a matching upstream server.

## Updating from upstream

```sh
git fetch upstream && git merge upstream/main
vp run check:changed upstream/main
```

The vim tests live in their own files (`*vim*.browser.test.*`), so most conflicts are one-line edits in shared components. Run the vim conformance suites after every merge: the adapters measure text on screen, and upstream layout changes break them quietly.

## Dev loops

- Web UI, including everything vim: `vp run dev --share`, then open the printed pairing URL. Edits hot-reload.
- Electron behaviour, on the Mac: `vp run dev:desktop`. Its data lives in `~/.t3/dev`, apart from the installed app.
- Installed app, on the Mac: `fork/install-mac-app.sh` pulls, builds the `.app`, replaces `/Applications/T3 Code (Beta).app` and relaunches it.
