# pasteVector

Paste vector images from the clipboard into Markdown files. Instead of the default paste, `Ctrl+Alt+V` saves the image as a file next to your document and inserts a Markdown image link — preserving vector quality for SVG content.

Designed for use in **WSL** (Windows Subsystem for Linux) with applications like ChemDraw, but also works on native Linux with X11 or Wayland.

## Features

- Pastes SVG, SVGZ, EMF (converted to SVG), PNG, and JPEG from the clipboard
- In WSL, reads directly from the Windows clipboard via PowerShell — no X server needed
- Converts EMF to SVG using `emf2svg-conv` — fast (~50 ms), no Inkscape required for the basic path
- Corrects EMF DPI scaling so pasted images are always at their correct document size
- Configurable output filename template, alt text, and clipboard backend

## Requirements

- **`wl-paste`** — Wayland clipboard access
- **`xclip`** — X11 clipboard access
- **`powershell.exe`** — Windows clipboard access from WSL (built into Windows)
- **`emf2svg-conv`** — Optional: EMF → SVG conversion (required for EMF content)
- **`inkscape`** — Optional: fit canvas to drawing after EMF or SVG paste

Only the tools relevant to your environment are needed. In WSL, `powershell.exe` is always available and is the primary clipboard backend.

```bash
sudo apt install wl-clipboard    # Wayland clipboard
sudo apt install xclip           # X11 clipboard

sudo apt install inkscape        # optional: canvas fitting
sudo apt install libemf2svg-dev  # optional: handles EMF
```

## Installation

### From VSIX (recommended)

1. Download the latest `.vsix` from the [Releases](https://github.com/gpbraun/pastevector/releases) page
2. In VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
3. Select the file and reload VS Code

Or from the terminal:

```bash
code --install-extension pastevector-0.2.1.vsix
```

### Build from source

```bash
git clone https://github.com/gpbraun/pastevector
cd pastevector
npm install
npm run compile
npx vsce package
code --install-extension pastevector-*.vsix
```

## Usage

1. Copy a vector image to the clipboard (e.g. from ChemDraw, Inkscape, or any app that copies as EMF or SVG)
2. Open a `.md` file in VS Code
3. Press `Ctrl+Alt+V`

The Markdown image link is inserted at the cursor immediately:

```markdown
![](img_notes_1234567890.svg)
```

The file is written in the background. If conversion fails, a notification appears in VS Code.

If the clipboard contains plain text or the file is not Markdown, the command falls back to the normal VS Code paste.

## Settings

- **`pasteVector.destinationTemplate`** (default: `img_${documentBaseName}_${unixTime}.${fileExtName}`)
  
  Output filename template. Available variables: `documentBaseName`, `unixTime`, `fileExtName`.

---

- **`pasteVector.preferBackend`** (default: `auto`)
  
  Linux clipboard backend: `auto`, `wayland`, or `x11`.

---

- **`pasteVector.altText`** (default: `""`)
  
  Alt text for the inserted Markdown image link.

---

- **`pasteVector.showLog`** (default: `false`)
  
  Show the pasteVector output channel while the command runs.

---

- **`pasteVector.copyMarkdownToClipboard`** (default: `false`)
  
  Also copy the inserted Markdown image link to the clipboard.

---

- **`pasteVector.finalizeSvgWithInkscape`** (default: `true`)
  
  After an SVG paste, run Inkscape to fit the canvas to the drawing and export as plain SVG. Adds ~1–3 s per paste. No effect if Inkscape is not in PATH.

---

- **`pasteVector.emfScalePercent`** (default: `125`)
  
  EMF DPI scale factor. SVG output dimensions are multiplied by `100/emfScalePercent`. Set to `100` to disable. Applies on all platforms.

---

- **`pasteVector.finalizeEmfWithInkscape`** (default: `true`)
  
  After an EMF paste, run Inkscape to fit the canvas to the drawing and export as plain SVG. Adds ~1–3 s per paste. No effect if Inkscape is not in PATH.

## Troubleshooting

- **Nothing happens on `Ctrl+Alt+V`**
    
    Run `pasteVector: Show Clipboard Types` from the Command Palette to see what formats are on the clipboard. Enable `pasteVector.showLog` for detailed output in the Output panel.

---

- **EMF conversion fails**
    
    Make sure `emf2svg-conv` is installed and on your PATH: `emf2svg-conv --version`. In WSL, `which emf2svg-conv` should return a result.

---

- **EMF image is the wrong size**
    
    Adjust `pasteVector.emfScalePercent` to match your display scaling. At 125% Windows display scaling the default value of `125` is correct. Set to `100` to disable scaling correction entirely.

