// URL とファイルを、OS の既定のアプリ（ブラウザ）で開くコマンド。

/**
 * target（URL かファイルのパス）を既定のアプリで開くコマンドと引数。
 * macOS は open、Linux は xdg-open に渡す。
 * Windows は rundll32 の FileProtocolHandler に渡す。cmd.exe の start を通すと、URL の & で文が切れて別のコマンドになる。
 * どれもシェルを通さず、target を 1 つの引数として渡す。
 */
export function openTargetCommand(target: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [target] };
  if (platform === 'win32') return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] };
  return { file: 'xdg-open', args: [target] };
}
