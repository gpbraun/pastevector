# pasteVector (Linux/WSL)

Hotkey (Markdown):
- Ctrl+Alt+V: If clipboard contains vector (SVG/EMF/PDF), writes an SVG file and inserts

Settings:
- pasteVector.destinationTemplate
- pasteVector.preferBackend (auto/wayland/x11)
- pasteVector.altText (string; empty => ![])

Requires:
- Wayland: wl-clipboard (wl-paste, wl-copy) OR
- X11: xclip
- Inkscape CLI (inkscape) for EMF/PDF→SVG conversion
npm
