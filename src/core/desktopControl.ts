import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../types.js';
import { buildSandboxedEnv, runCommand } from '../utils/exec.js';

async function runPowerShell(script: string, timeoutMs = 10_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (process.platform !== 'win32') {
    throw new Error('Windows PowerShell desktop automation is only available on Windows.');
  }
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const res = await runCommand({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    env: buildSandboxedEnv(),
    timeoutMs,
  });
  return {
    ok: res.exitCode === 0 && !res.timedOut,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
  };
}

export async function runDesktopAction(
  config: AppConfig,
  params: {
    action:
      | 'system_info'
      | 'clipboard_read'
      | 'clipboard_write'
      | 'list_windows'
      | 'notify'
      | 'open_target'
      | 'run_powershell';
    text?: string;
    title?: string;
    target?: string;
    script?: string;
  },
): Promise<string> {
  if (!config.enableDesktopControl) {
    throw new Error('desktop_control is disabled (set ENABLE_DESKTOP_CONTROL=true to enable).');
  }

  switch (params.action) {
    case 'system_info': {
      const info = {
        platform: process.platform,
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        cpus: os.cpus().length,
        totalMemoryGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
        freeMemoryGB: Number((os.freemem() / 1024 ** 3).toFixed(2)),
        uptimeHours: Number((os.uptime() / 3600).toFixed(2)),
        nodeVersion: process.version,
      };
      return JSON.stringify(info, null, 2);
    }

    case 'clipboard_read': {
      const res = await runPowerShell('Get-Clipboard -Raw');
      if (!res.ok) throw new Error(`Failed to read clipboard: ${res.stderr}`);
      return res.stdout || '(clipboard is empty)';
    }

    case 'clipboard_write': {
      if (params.text === undefined) {
        throw new Error('text is required for clipboard_write.');
      }
      const b64 = Buffer.from(params.text, 'utf8').toString('base64');
      const script = `$t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t; 'OK'`;
      const res = await runPowerShell(script);
      if (!res.ok) throw new Error(`Failed to write clipboard: ${res.stderr}`);
      return `Copied ${params.text.length} characters to clipboard.`;
    }

    case 'list_windows': {
      const script = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;
      const res = await runPowerShell(script);
      if (!res.ok) throw new Error(`Failed to list windows: ${res.stderr}`);
      return res.stdout || '[]';
    }

    case 'notify': {
      const title = (params.title || 'Gemini Coworker').slice(0, 100);
      const message = (params.text || '').slice(0, 300);
      if (!message) throw new Error('text is required for notify.');
      const titleB64 = Buffer.from(title, 'utf8').toString('base64');
      const msgB64 = Buffer.from(message, 'utf8').toString('base64');
      const script = `
Add-Type -AssemblyName System.Windows.Forms
$title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleB64}'))
$msg = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${msgB64}'))
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = $title
$n.BalloonTipText = $msg
$n.Visible = $true
$n.ShowBalloonTip(4000)
Start-Sleep -Milliseconds 500
$n.Dispose()
'Notification sent'
`;
      const res = await runPowerShell(script, 10_000);
      if (!res.ok) throw new Error(`Failed to send notification: ${res.stderr}`);
      return `Notification displayed: "${title}"`;
    }

    case 'open_target': {
      const target = params.target?.trim();
      if (!target) throw new Error('target is required for open_target.');

      const isHttpUrl = /^https?:\/\//i.test(target);
      if (!isHttpUrl) {
        const resolved = path.resolve(target);
        if (!fs.existsSync(resolved)) {
          throw new Error(`Target path does not exist: ${resolved}`);
        }
      }
      const b64 = Buffer.from(target, 'utf8').toString('base64');
      const script = `$target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Start-Process -FilePath $target; 'Opened'`;
      const res = await runPowerShell(script);
      if (!res.ok) throw new Error(`Failed to open target: ${res.stderr}`);
      return `Opened target: ${target}`;
    }

    case 'run_powershell': {
      if (!config.enableDesktopPowershell) {
        throw new Error(
          'desktop_control(action="run_powershell") is disabled by default. Set ENABLE_DESKTOP_POWERSHELL=true in .env to allow it.',
        );
      }
      if (!params.script?.trim()) {
        throw new Error('script is required for run_powershell.');
      }
      const res = await runPowerShell(params.script, 15_000);
      const output = [res.stdout, res.stderr ? `[stderr]\n${res.stderr}` : '']
        .filter(Boolean)
        .join('\n');
      if (!res.ok) {
        throw new Error(`PowerShell failed:\n${output}`);
      }
      return output || '(completed with no output)';
    }
  }
}
