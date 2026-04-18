# pasteVector

Paste vector images from the clipboard into Markdown files. Instead of the default paste, `Ctrl+Alt+V` saves the image as a file next to your document and inserts a Markdown image link — preserving vector quality for SVG content.

Designed for use in **WSL** (Windows Subsystem for Linux) with applications like ChemDraw, but also works on native Linux with X11 or Wayland.

## Features

- Pastes SVG, EMF (converted to SVG), PNG, and JPEG from the clipboard
- In WSL, reads directly from the Windows clipboard via PowerShell — no X server needed
- Converts EMF to SVG using Inkscape, with text converted to paths and canvas fitted to the drawing
- Corrects HiDPI display scaling so pasted images are always at their correct document size
- Configurable output filename template, alt text, and clipboard backend

## Requirements

| Tool | Purpose |
|------|---------|
| `inkscape` | EMF → SVG conversion, canvas fitting |
| `wl-paste` | Wayland clipboard access (install `wl-clipboard`) |
| `xclip` | X11 clipboard access |
| `powershell.exe` | Windows clipboard access from WSL (built into Windows) |

Only the tools relevant to your environment are needed. In WSL, `powershell.exe` is always available and is the primary clipboard backend; `wl-paste`/`xclip` are fallbacks.

## Installation

### From VSIX (recommended)

1. Download the latest `.vsix` file from the [Releases](https://github.com/gpbraun/pastevector/releases) page
2. In VS Code, open the Command Palette (`Ctrl+Shift+P`) and run **Extensions: Install from VSIX...**
3. Select the downloaded file and reload VS Code when prompted

Or install from the terminal:

```bash
code --install-extension pastevector-x.x.x.vsix
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

### Install dependencies (WSL/Ubuntu)

```bash
# Inkscape
sudo apt install inkscape

# Wayland clipboard (optional, for native Linux Wayland)
sudo apt install wl-clipboard

# X11 clipboard (optional, for native Linux X11)
sudo apt install xclip
```

## Usage

1. Copy a vector image to the clipboard (e.g. from ChemDraw, Inkscape, or any application that copies as EMF or SVG)
2. Open a `.md` file in VS Code
3. Press `Ctrl+Alt+V`

The image is saved as a file next to the Markdown document and a link is inserted at the cursor:

```markdown
![](img_notes_1234567890.svg)
```

If the clipboard contains plain text or the file is not Markdown, the command falls back to the normal VS Code paste.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `pasteVector.destinationTemplate` | `img_${documentBaseName}_${unixTime}.${fileExtName}` | Output filename template. Variables: `documentBaseName`, `unixTime`, `fileExtName` |
| `pasteVector.preferBackend` | `auto` | Linux clipboard backend: `auto`, `wayland`, or `x11` |
| `pasteVector.altText` | `""` | Alt text for the inserted Markdown image link |
| `pasteVector.finalizeSvgWithInkscape` | `true` | Run Inkscape on generated SVGs to fit the canvas and save as plain SVG |
| `pasteVector.showLog` | `false` | Show the pasteVector output channel while the command runs |
| `pasteVector.copyMarkdownToClipboard` | `false` | Also copy the inserted Markdown image link to the clipboard |

## Troubleshooting

**Nothing happens on `Ctrl+Alt+V`**
Run `pasteVector: Show Clipboard Types` from the Command Palette to see what formats are on the clipboard. Enable `pasteVector.showLog` to see detailed output in the Output panel.

**EMF conversion fails**
Make sure `inkscape` is installed and on your PATH: `inkscape --version`. In WSL, `which inkscape` should return a result.

**Image is the wrong size**
The extension automatically corrects for Windows HiDPI display scaling (125%, 150%, etc.) by reading the EMF header. If the size still looks off, check the `pasteVector` output channel for the logged dimensions.
