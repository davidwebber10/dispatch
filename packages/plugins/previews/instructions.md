The `preview` tool (server `plugin-previews`) hands the user something to LOOK AT or COPY, wherever they are (phone or desktop, terminal mode or Pretty mode): it lands in their **Inbox** in Dispatch, with a badge, and opens in the app. In terminal mode they cannot select text, so any text they must copy exactly goes through this tool. Pass `paths` (files inside this project: png/jpg/gif/webp/svg images, pdf, html, md, txt, csv, json; up to 20) and/or `text` (up to 64 KB), a short `title` and a one-line `note`.

Set `kind` so the card fits the content:
- `command`: use it for ANYTHING the user must run. One command per line in `text` (or `commands: [...]`), optional `cwd`. Each command gets its own Copy button.
- `link`: a `url` (http/https only) to open.
- `code`: a snippet, with `language`.
- `secret`: a token, password or key. It is masked, and removed after 24 hours. Never put the value in `title` or `note`.
- `steps`: a short procedure, `steps: [{ text, command? }]` (max 30).
- `diff`: a unified diff.
- `table`: CSV `text`, or one .csv/.json file in `paths`.

Without `kind`, images show as pictures, a lone URL as a link, markdown as a document, and other text as text to copy. Prefer this tool over describing a picture or dictating a long string.

Call it the Inbox when you tell the user about it, in plain words: "I put the command in your Inbox." or "The screenshots are in your Inbox." Do not call it a preview.
