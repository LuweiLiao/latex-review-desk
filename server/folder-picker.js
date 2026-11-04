import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
// IFileOpenDialog opens the same Windows folder picker used by desktop apps.
const WINDOWS_PICKER = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeFolderPicker {
  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr types);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint type, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName(string name, IntPtr context, ref Guid iid, out IShellItem item);
  public static string Choose(string initial) {
    IFileOpenDialog dialog = (IFileOpenDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
    try {
      dialog.SetOptions(0x20 | 0x40 | 0x800 | 0x8);
      dialog.SetTitle("选择 LaTeX 论文文件夹");
      dialog.SetOkButtonLabel("选择文件夹");
      if (!String.IsNullOrEmpty(initial) && System.IO.Directory.Exists(initial)) {
        Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        IShellItem folder; SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
        try { dialog.SetDefaultFolder(folder); } finally { Marshal.ReleaseComObject(folder); }
      }
      int code = dialog.Show(IntPtr.Zero);
      if (code == unchecked((int)0x800704C7)) return null;
      Marshal.ThrowExceptionForHR(code);
      IShellItem result; dialog.GetResult(out result);
      try {
        IntPtr value; result.GetDisplayName(0x80058000, out value);
        try { return Marshal.PtrToStringUni(value); } finally { Marshal.FreeCoTaskMem(value); }
      } finally { Marshal.ReleaseComObject(result); }
    } finally { Marshal.ReleaseComObject(dialog); }
  }
}
'@
$folder = [NativeFolderPicker]::Choose($env:LRD_PICKER_INITIAL)
if ($folder) { [Console]::WriteLine($folder) }
} catch { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }
`;

export async function chooseFolder({ initialPath = '', platform = process.platform, run = execute } = {}) {
  let command, args;
  if (platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(WINDOWS_PICKER, 'utf16le').toString('base64')];
  } else if (platform === 'darwin') {
    command = 'osascript';
    args = ['-e', 'POSIX path of (choose folder with prompt "选择 LaTeX 论文文件夹")'];
  } else {
    command = 'zenity';
    args = ['--file-selection', '--directory', '--title=选择 LaTeX 论文文件夹', ...(initialPath ? [`--filename=${initialPath}/`] : [])];
  }
  try {
    const { stdout } = await run(command, args, { windowsHide: true, encoding: 'utf8', env: { ...process.env, LRD_PICKER_INITIAL: platform === 'win32' && initialPath ? path.win32.normalize(initialPath) : initialPath } });
    return stdout.replace(/^\uFEFF/, '').trim() || null;
  } catch (error) {
    if (platform === 'linux' && error.code === 1 || platform === 'darwin' && /(-128|User canceled)/.test(error.stderr || '')) return null;
    throw new Error(`无法打开系统文件夹窗口：${error.stderr?.trim() || error.message}`);
  }
}

export function createFolderPicker(options = {}) {
  let pending;
  return (initialPath) => pending ||= chooseFolder({ ...options, initialPath }).finally(() => { pending = null; });
}
