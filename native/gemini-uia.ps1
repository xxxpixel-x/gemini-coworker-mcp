# Windows PowerShell 5.1. Read a UTF-8 JSON request encoded as ASCII base64 on stdin.
param([switch]$Isolated, [switch]$InitializeIsolated, [switch]$IsolatedWorker, [switch]$CheckForeground)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$notSent = $true
$mutex = $null
$held = $false
function Emit($value) { [Console]::WriteLine((ConvertTo-Json $value -Compress -Depth 6)) }
function Children-OfType($element, $kind, $scope) {
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$kind)
    return $element.FindAll($scope,$condition)
}
function Get-GeminiWindows {
    $sessionNumber = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $knownRoots = @($folders | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') + '\' })
    $processes = @(Get-Process -Name Gemini -ErrorAction SilentlyContinue | Where-Object {
        $exe = $_.Path
        $inInstall = $false
        foreach ($prefix in $knownRoots) { if ($exe -and $exe.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { $inInstall=$true } }
        $inInstall -and $_.SessionId -eq $sessionNumber
    })
    $ids = @($processes | ForEach-Object { $_.Id })
    $windows = @()
    if ($ids.Count -and $IsolatedWorker) {
        foreach ($handle in [IsolatedDesktop]::Windows([int[]]$ids)) {
            [IsolatedDesktop]::AssertWindow($handle)
            $windows += [Windows.Automation.AutomationElement]::FromHandle($handle)
        }
    } elseif ($ids.Count) {
        foreach ($w in [Windows.Automation.AutomationElement]::RootElement.FindAll(
            [Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)) {
            if ($ids -contains $w.Current.ProcessId) { $windows += $w }
        }
    }
    $builds = @($processes | ForEach-Object {
        if ($_.Path -match '[\\/]app-([0-9.]+)[\\/]Gemini\.exe$') { $Matches[1] }
    } | Sort-Object -Unique)
    $runningVersion = if ($builds.Count -eq 1) { $builds[0] } else { $null }
    return @{ running=($ids.Count -gt 0); windows=$windows; version=$runningVersion }
}
function Chat-Route($doc) {
    $vp = $null
    if (-not $doc.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$vp)) { return }
    $uri = $null
    if (-not [Uri]::TryCreate($vp.Current.Value,[UriKind]::Absolute,[ref]$uri)) { return }
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'gemini.google.com') { return }
    if ($uri.AbsolutePath -cmatch '^/(?:u/[0-9]+/)?app/?$') { return 'blank' }
    if ($uri.AbsolutePath -cnotmatch '^/(?:u/[0-9]+/)?app/[a-zA-Z0-9_-]+/?$') { return }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($uri.AbsolutePath.TrimEnd('/'))))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Document-At($w) {
    $docs = @(Children-OfType $w ([Windows.Automation.ControlType]::Document) ([Windows.Automation.TreeScope]::Descendants) |
        Where-Object { -not $_.Current.IsOffscreen -and (Chat-Route $_) })
    if ($docs.Count -eq 1) { return $docs[0] }
}
function Same-Document($w, $doc, $route) {
    $now = Document-At $w
    if (-not $now -or -not [Windows.Automation.Automation]::Compare($now,$doc) -or (Chat-Route $now) -cne $route) { throw 'Dedicated conversation changed or closed.' }
}
try {
    if ($Isolated -or $InitializeIsolated -or $IsolatedWorker) {
        Add-Type -Path (Join-Path $PSScriptRoot 'IsolatedDesktop.cs')
        if (!$IsolatedWorker) {
            try { exit [IsolatedDesktop]::RunWorker($PSCommandPath, [bool]$InitializeIsolated, [bool]$CheckForeground) }
            catch {
                if (!$CheckForeground) { throw }
                [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
                exit 1
            }
        }
        [IsolatedDesktop]::AssertWorker()
    }
    $q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GeminiWindowState { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }'
    $folders = @([Environment]::GetFolderPath('LocalApplicationData'),$env:ProgramFiles) |
        Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Google\Gemini' }
    # Start-menu shortcuts also resolve the real install when LocalAppData is redirected.
    $shell = New-Object -ComObject WScript.Shell
    foreach ($special in @('Programs','CommonPrograms')) {
        $start = [Environment]::GetFolderPath($special)
        if ($start -and (Test-Path -LiteralPath $start)) {
            foreach ($link in Get-ChildItem -LiteralPath $start -Filter 'Gemini.lnk' -Recurse -ErrorAction SilentlyContinue) {
                $target = $shell.CreateShortcut($link.FullName).TargetPath
                if ($target -and $target.EndsWith('\Google\Gemini\Gemini.exe',[StringComparison]::OrdinalIgnoreCase)) {
                    $folders += (Split-Path $target)
                }
            }
        }
    }
    $installed = $false
    $version = $null
    foreach ($dir in $folders) {
        if (Test-Path -LiteralPath (Join-Path $dir 'Gemini.exe') -PathType Leaf) {
            $installed = $true
            $build = Get-ChildItem -LiteralPath $dir -Directory -Filter 'app-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($build) { $version = $build.Name.Substring(4) }
            break
        }
    }
    if ($IsolatedWorker -and $q.action -eq 'start-isolated') {
        if (!$installed -or !$build) { throw 'Could not locate the installed Gemini application.' }
        $image = Join-Path $build.FullName 'Gemini.exe'
        $started = [IsolatedDesktop]::StartGemini($image)
        Emit @{process_id=$started;desktop=[IsolatedDesktop]::Name;input=[IsolatedDesktop]::InputName()}
        return
    }
    $inventory = Get-GeminiWindows
    if ($inventory.running) { $version=$inventory.version }
    $views = @()
    foreach ($window in $inventory.windows) {
        $doc = Document-At $window
        if ($doc) {
            $views += @{ window=$window; doc=$doc; route=(Chat-Route $doc); handle=$window.Current.NativeWindowHandle }
        }
    }
    if ($q.action -in @('inspect','windows')) {
        $available = @($q.bindings | Where-Object {
            $route = $_.route
            $route -and @($views | Where-Object { $_.route -ceq $route }).Count -eq 1
        } | ForEach-Object { $_.session_id })
        $reason = if (-not $installed -and -not $inventory.running) { 'Gemini installation was not found.' }
            elseif (-not $inventory.running) { 'No Gemini process is visible in this Windows session.' }
            elseif (-not $available.Count) { 'No bound conversation is visible. Use npm run desktop:bind in the interactive Windows session.' }
            else { 'Bound conversation found. Independent background use requires acceptance testing.' }
        $background = if ($available.Count) { 'unverified' } else { 'unavailable' }
        if ($q.action -eq 'windows') {
            Emit @{windows=@($views | ForEach-Object { @{handle=$_.handle;blank=($_.route -ceq 'blank')} })}
        } else {
            Emit @{installed=($installed -or $inventory.running);running=$inventory.running;version=$version;login='unknown';
                    background=$background;sessions=$available;reason=$reason}
        }
        return
    }
    $binding = $q.action -eq 'bind'
    $checking = $q.action -eq 'check'
    if ($q.action -notin @('bind','turn','check') -or $q.receipt -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid desktop request.' }
    if ($binding) { $selected = @($views | Where-Object { $_.handle -eq $q.handle }) }
    else { $selected = @($views | Where-Object { $_.route -ceq $q.route -and $_.route -cne 'blank' }) }
    if ($selected.Count -ne 1) { throw 'No unique dedicated Gemini document matched this request.' }
    $view = $selected[0]
    $w = $view.window
    $doc = $view.doc
    $route = $view.route
    if ($binding -and $route -cne 'blank') { Emit @{route=$route}; return }
    if ($q.action -eq 'turn' -and $q.versions -notcontains $version) { throw 'The running Gemini version has not passed background checks.' }
    if (!$IsolatedWorker -and $binding -and $route -eq 'blank' -and $q.blocked_versions -contains $version) { throw 'A background input check failed on this installation. Bind an already-created dedicated chat to recheck explicitly.' }
    $mutex = New-Object Threading.Mutex($false,'Local\GeminiDesktopMCP.UIAutomation.v1')
    try { $held = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Gemini is busy in another gateway process.' }
    $scope = [Windows.Automation.TreeScope]::Descendants
    $editors = @(Children-OfType $doc ([Windows.Automation.ControlType]::Edit) $scope | Where-Object {
        $vp = $null
        $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and $_.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$vp) -and -not $vp.Current.IsReadOnly
    })
    if ($editors.Count -ne 1) { throw 'Composer does not expose one background-writable UIA ValuePattern.' }
    $editor = $editors[0].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $draft = $editor.Current.Value.Trim()
    $placeholder = $editors[0].Current.ClassName -match '(?:^| )ql-blank(?: |$)' -and $draft -match '^(Ask Gemini|Ask anything|Message Gemini|\u95ee\u95ee Gemini|\u5411 Gemini \u63d0\u95ee)$'
    if ($draft -and -not $placeholder) { throw 'Dedicated composer contains an existing draft.' }
    $text = $null
    if (-not $doc.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$text)) { throw 'Document does not expose complete text.' }
    $receipt = [string]$q.receipt
    $begin = "MCP_BEGIN_$receipt"
    $end = "MCP_END_$receipt"
    $instruction = "Put $begin alone on the first line of the response. Between the markers write a JSON object with a single string field named reply containing your entire answer (escape newlines and code). Put $end alone on the last line. Use plain text."
    $promptText = if ($binding) { 'This is a dedicated test conversation. Reply with the word ready.' } else { [string]$q.prompt }
    $message = $promptText + [Environment]::NewLine + [Environment]::NewLine + $instruction
    $foreground = [GeminiWindowState]::GetForegroundWindow()
    if ($IsolatedWorker) { [IsolatedDesktop]::AssertWindow([IntPtr]$w.Current.NativeWindowHandle) }
    elseif ($foreground.ToInt64() -eq $w.Current.NativeWindowHandle) { throw 'Dedicated Gemini window is in the foreground.' }
    if ($checking -and !$IsolatedWorker) {
        $geminiHandles = @($inventory.windows | ForEach-Object { [int64]$_.Current.NativeWindowHandle })
        $personal = $geminiHandles -contains $foreground.ToInt64()
        if (($q.scenario -eq 'personal-gemini') -ne $personal) { throw 'Foreground does not match the selected acceptance scenario.' }
    }
    $clipboard = [GeminiWindowState]::GetClipboardSequenceNumber()
    Same-Document $w $doc $route
    
    $focusBefore = if (!$IsolatedWorker) { [Windows.Automation.AutomationElement]::FocusedElement }
    if ($IsolatedWorker) { [IsolatedDesktop]::AssertWindow([IntPtr]$w.Current.NativeWindowHandle) }
    $editor.SetValue($message)
    $until = [DateTime]::UtcNow.AddSeconds(3)
    do {
        Same-Document $w $doc $route
        $buttons = @(Children-OfType $doc ([Windows.Automation.ControlType]::Button) $scope | Where-Object {
            $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and $_.Current.Name -match '^(Send|Send message|Submit|Submit message|\u53d1\u9001|\u53d1\u9001\u6d88\u606f|\u63d0\u4ea4|\u63d0\u4ea4\u63d0\u793a|\u53d1\u9001\u63d0\u793a)$'
        })
        if ($IsolatedWorker) { [IsolatedDesktop]::AssertWindow([IntPtr]$w.Current.NativeWindowHandle) }
        elseif ([GeminiWindowState]::GetForegroundWindow().ToInt64() -eq $w.Current.NativeWindowHandle) { throw 'Background check failed: Gemini acquired foreground while setting the draft. No send was invoked.' }
        if ($buttons.Count -eq 1) { break }
        Start-Sleep -Milliseconds 100
    } until ([DateTime]::UtcNow -gt $until)
    if ($buttons.Count -ne 1 -or ($editor.Current.Value -replace "\r\n?","`n").TrimEnd("`n") -cne ($message -replace "\r\n?","`n").TrimEnd("`n")) { throw 'Could not verify the draft and send control; inspect the dedicated chat.' }
    if (!$IsolatedWorker -and ([GeminiWindowState]::GetForegroundWindow() -ne $foreground -or [GeminiWindowState]::GetClipboardSequenceNumber() -ne $clipboard)) { throw 'Desktop state changed before send; inspect the dedicated chat.' }
    $currentFocus = if (!$IsolatedWorker) { [Windows.Automation.AutomationElement]::FocusedElement }
    if ($focusBefore -and $currentFocus -and -not [Windows.Automation.Automation]::Compare($focusBefore,$currentFocus)) { throw 'Input focus changed before send. No send was invoked.' }
    $invoke = $buttons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    Same-Document $w $doc $route
    if ($IsolatedWorker) { [IsolatedDesktop]::AssertWindow([IntPtr]$w.Current.NativeWindowHandle) }
    $notSent = $false
    $invoke.Invoke()
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    $pattern = '(?ms)^[ \t]*' + $begin + '[ \t]*\r?\n(.*?)\r?\n[ \t]*' + $end + '[ \t]*\r?$'
    do {
        Start-Sleep -Milliseconds 350
        if ($IsolatedWorker) { [IsolatedDesktop]::AssertWindow([IntPtr]$w.Current.NativeWindowHandle) }
        elseif ([GeminiWindowState]::GetForegroundWindow().ToInt64() -eq $w.Current.NativeWindowHandle) { throw 'Dedicated window acquired focus after send.' }
        if ($checking -and [GeminiWindowState]::GetClipboardSequenceNumber() -ne $clipboard) { throw 'Clipboard changed during acceptance check.' }
        if ($binding) {
            $doc = Document-At $w
            if (-not $doc -or (Chat-Route $doc) -eq 'blank') { continue }
            $text = $null
            if (-not $doc.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$text)) { continue }
        } else { Same-Document $w $doc $route }
        $matchesFound = [regex]::Matches($text.DocumentRange.GetText(-1),$pattern)
        if ($matchesFound.Count -eq 1) {
            $body = $matchesFound[0].Groups[1].Value.Trim()
            try { $response = ConvertFrom-Json -InputObject $body -ErrorAction Stop } catch { continue }
            if ($response.reply -is [string] -and $response.reply.Length -gt 0) {
                $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($response.reply))
                Emit @{receipt=$receipt;reply_base64=$encoded;route=(Chat-Route $doc)}
                return
            }
        }
    } until ([DateTime]::UtcNow -gt $deadline)
    throw 'Sent, but no complete matching reply could be read. Check the dedicated conversation.'
} catch {
    Emit @{error=$_.Exception.Message;not_sent=$notSent}
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
