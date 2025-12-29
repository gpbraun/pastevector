OUT=/tmp/clip.emf
WIN_OUT=$(wslpath -w "$OUT")

powershell.exe -NoProfile -STA -Command "
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class ClipEmf {
  const uint CF_ENHMETAFILE = 14;

  [DllImport(\"user32.dll\", ExactSpelling=true)]
  static extern bool OpenClipboard(IntPtr hWndNewOwner);

  [DllImport(\"user32.dll\", ExactSpelling=true)]
  static extern bool CloseClipboard();

  [DllImport(\"user32.dll\", ExactSpelling=true)]
  static extern bool IsClipboardFormatAvailable(uint format);

  [DllImport(\"user32.dll\", ExactSpelling=true)]
  static extern IntPtr GetClipboardData(uint format);

  [DllImport(\"gdi32.dll\", ExactSpelling=true)]
  static extern uint GetEnhMetaFileBits(IntPtr hemf, uint cbBuffer, byte[] lpbBuffer);

  public static int Save(string path) {
    if (!IsClipboardFormatAvailable(CF_ENHMETAFILE)) return 2;
    if (!OpenClipboard(IntPtr.Zero)) return 3;
    IntPtr hemf = GetClipboardData(CF_ENHMETAFILE);
    CloseClipboard();
    if (hemf == IntPtr.Zero) return 4;

    uint size = GetEnhMetaFileBits(hemf, 0, null);
    if (size == 0) return 5;

    byte[] buf = new byte[size];
    uint got = GetEnhMetaFileBits(hemf, size, buf);
    if (got != size) return 6;

    File.WriteAllBytes(path, buf);
    return 0;
  }
}
'@

exit [ClipEmf]::Save('$WIN_OUT')
"
