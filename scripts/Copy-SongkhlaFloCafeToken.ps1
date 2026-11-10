$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$handoff = Join-Path $env:LOCALAPPDATA 'FloCafe-Songkhla-Setup/connector.dpapi'
$encrypted = (Get-Content -LiteralPath $handoff -Raw).Trim()
$secureToken = $encrypted | ConvertTo-SecureString
$token = [System.Net.NetworkCredential]::new('', $secureToken).Password
if ($token -notmatch '^[!-~]{24,512}$') { throw 'Invalid connector token.' }

$clipboard = [System.Windows.Forms.DataObject]::new()
$clipboard.SetText($token, [System.Windows.Forms.TextDataFormat]::UnicodeText)
$exclude = [System.IO.MemoryStream]::new([byte[]]@(1))
$clipboard.SetData('ExcludeClipboardContentFromMonitorProcessing', $false, $exclude)
try {
    [System.Windows.Forms.Clipboard]::SetDataObject($clipboard, $true, 10, 100)
    Write-Host 'Paste into the FloCafe token field within 45 seconds.'
    Start-Sleep -Seconds 45
} finally {
    if ([System.Windows.Forms.Clipboard]::GetText() -ceq $token) {
        [System.Windows.Forms.Clipboard]::Clear()
    }
    $exclude.Dispose()
    $secureToken.Dispose()
    Remove-Variable token, clipboard, encrypted
}
