import * as vscode from 'vscode';
import * as path from 'path';
import { ScriptRunner, RunningScript } from '../services/ScriptRunner';
import { NodeVersionManager } from '../services/NodeVersionManager';

export class NpmRunnerPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'npmRunner.panel';
    private view?: vscode.WebviewView;
    private activeTabId: string = '';

    constructor(
        private context: vscode.ExtensionContext,
        private scriptRunner: ScriptRunner,
        private nodeVersionManager: NodeVersionManager
    ) {
        scriptRunner.onOutput(({ id, data }) => {
            if (this.view && this.activeTabId === id) {
                this.view.webview.postMessage({ cmd: 'output', data });
            }
        });

        scriptRunner.onScriptsChanged(() => {
            this.updateTitle();
            this.refresh();
        });
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        this.activeTabId = '';

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };

        webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.activeTabId = '';
                const scripts = this.scriptRunner.getAllScripts();
                if (scripts.length > 0) {
                    this.activeTabId = scripts[scripts.length - 1].id;
                }
                this.view!.webview.html = this.getHtml();
                this.updateTitle();
            }
        });

        this.view.webview.html = this.getHtml();
        this.updateTitle();
    }

    private updateTitle(): void {
        if (this.view) {
            const count = this.scriptRunner.getRunningScripts().length;
            this.view.title = count > 0 ? `NPM Runner (${count})` : 'NPM Runner';
        }
    }

    setActiveTab(id: string): void {
        this.activeTabId = id;
        this.refresh();
    }

    refresh(): void {
        if (!this.view) return;

        const scripts = this.scriptRunner.getAllScripts();
        if (scripts.length > 0 && !this.activeTabId) {
            this.activeTabId = scripts[scripts.length - 1].id;
        }
        if (scripts.length === 0) {
            this.activeTabId = '';
        }

        this.view.webview.html = this.getHtml();
    }

    reveal(): void {
        if (this.view) {
            this.view.show(true);
        }
    }

    private async handleMessage(msg: any): Promise<void> {
        switch (msg.cmd) {
            case 'stop':
                this.scriptRunner.stopScript(msg.id);
                break;
            case 'restart':
                this.scriptRunner.restartScript(msg.id);
                break;
            case 'remove':
                this.scriptRunner.removeScript(msg.id);
                if (this.activeTabId === msg.id) {
                    const scripts = this.scriptRunner.getAllScripts();
                    this.activeTabId = scripts.length > 0 ? scripts[0].id : '';
                }
                this.refresh();
                break;
            case 'clear':
                this.scriptRunner.clearOutput(msg.id);
                this.refresh();
                break;
            case 'selectTab':
                this.activeTabId = msg.id;
                this.refresh();
                break;
            case 'askAI':
                this.askCursorAI(msg.id);
                break;
            case 'showScripts':
                vscode.commands.executeCommand('npmRunner.showAllScripts');
                break;
            case 'killPort':
                this.killPort(msg.port);
                break;
            case 'switchNodeVersion':
                this.switchNodeVersion(msg.id);
                break;
        }
    }

    private async switchNodeVersion(scriptId: string): Promise<void> {
        const script = this.scriptRunner.getScript(scriptId);
        if (!script) return;

        const newVersion = await this.nodeVersionManager.showVersionPicker(script.name, script.cwd);
        
        if (newVersion !== undefined) {
            await this.scriptRunner.updateScriptNodeVersion(scriptId, newVersion);
            
            const isRunning = script.status === 'running';
            if (isRunning) {
                const restart = await vscode.window.showInformationMessage(
                    `Node version changed to ${newVersion || 'system default'}. Restart script to apply?`,
                    'Restart Now',
                    'Later'
                );
                if (restart === 'Restart Now') {
                    await this.scriptRunner.restartScript(scriptId);
                }
            } else {
                this.refresh();
            }
        }
    }

    private async killPort(port: string): Promise<void> {
        const { exec } = require('child_process');
        exec(`lsof -ti:${port} | xargs kill -9`, (error: any) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to kill port ${port}`);
            } else {
                vscode.window.showInformationMessage(`Port ${port} killed successfully`);
            }
        });
    }

    private async askCursorAI(scriptId: string): Promise<void> {
        const script = this.scriptRunner.getScript(scriptId);
        if (!script) return;

        const lastLines = script.output.slice(-30).join('');
        const cleanOutput = lastLines.replace(/\x1b\[[0-9;]*m/g, '');

        const prompt = `I'm running \`npm run ${script.name}\` in ${script.cwd} and got this error:\n\n\`\`\`\n${cleanOutput}\n\`\`\`\n\nHow can I fix this?`;

        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('Error context copied! Open Cursor AI chat and paste.');
        
        vscode.commands.executeCommand('workbench.action.chat.open');
    }

    private getHtml(): string {
        const scripts = this.scriptRunner.getAllScripts();
        const activeScript = scripts.find(s => s.id === this.activeTabId);

        const tabsHtml = scripts.map(s => {
            const isActive = s.id === this.activeTabId;
            const projectName = path.basename(s.cwd);
            const statusClass = s.status;
            const portLabel = s.port ? ` :${s.port}` : '';
            return `
                <div class="tab ${isActive ? 'active' : ''} ${statusClass}" onclick="selectTab('${s.id}')">
                    <span class="tab-status"></span>
                    <span class="tab-label">${this.esc(projectName)}:${this.esc(s.name)}${portLabel}</span>
                    <button class="tab-close" onclick="event.stopPropagation();remove('${s.id}')" title="Close">×</button>
                </div>
            `;
        }).join('');

        const outputHtml = activeScript
            ? activeScript.output.map(o => this.ansiToHtml(o)).join('')
            : '';

        const isRunning = activeScript?.status === 'running';
        const hasError = activeScript?.status === 'error';

        const portMatch = activeScript?.output.join('').match(/Port (\d+) is in use/i) 
            || activeScript?.output.join('').match(/localhost:(\d+)/i)
            || activeScript?.output.join('').match(/EADDRINUSE.*:(\d+)/i);
        const stuckPort = portMatch ? portMatch[1] : null;

        const toolbarHtml = activeScript ? `
            <div class="toolbar">
                ${isRunning ? `
                    <button class="icon-btn stop" onclick="stop('${activeScript.id}')" title="Stop">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>
                    </button>
                    <button class="icon-btn" onclick="restart('${activeScript.id}')" title="Restart">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 2v4h-4l1.3-1.3A4.5 4.5 0 1 0 12.5 8h1a5.5 5.5 0 1 1-1.8-4L13.5 2z"/></svg>
                    </button>
                ` : `
                    <button class="icon-btn play" onclick="restart('${activeScript.id}')" title="Run Again">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>
                    </button>
                `}
                <button class="icon-btn" onclick="clear('${activeScript.id}')" title="Clear Output">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v2H2zM3 6h10v8H3zM6 1h4v2H6z"/></svg>
                </button>
                ${hasError ? `
                    <button class="icon-btn ai" onclick="askAI('${activeScript.id}')" title="Ask AI for help">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6"/><circle cx="6" cy="6" r="1.5" fill="#1e1e1e"/><circle cx="10" cy="6" r="1.5" fill="#1e1e1e"/><path d="M5 10c1.5 2 4.5 2 6 0" stroke="#1e1e1e" fill="none" stroke-width="1.5"/></svg>
                    </button>
                ` : ''}
                ${stuckPort ? `
                    <button class="icon-btn kill-port" onclick="killPort('${stuckPort}')" title="Kill port ${stuckPort}">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l2 5h5l-4 3 2 5-5-3-5 3 2-5-4-3h5z"/></svg>
                    </button>
                ` : ''}
                <div class="spacer"></div>
                <span class="path">${this.esc(activeScript.cwd)}</span>
            </div>
        ` : '';

        const nodeVersionDisplay = activeScript?.nodeVersion || 'system';

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
:root {
    --bg: var(--vscode-panel-background, #1e1e1e);
    --bg2: var(--vscode-sideBar-background, #252526);
    --border: var(--vscode-panel-border, #3c3c3c);
    --text: var(--vscode-foreground, #cccccc);
    --text2: var(--vscode-descriptionForeground, #858585);
    --green: var(--vscode-terminal-ansiGreen, #4ec9b0);
    --red: var(--vscode-terminal-ansiRed, #f14c4c);
    --yellow: var(--vscode-terminal-ansiYellow, #dcdcaa);
    --blue: var(--vscode-terminal-ansiBlue, #569cd6);
    --magenta: var(--vscode-terminal-ansiMagenta, #c586c0);
    --cyan: var(--vscode-terminal-ansiCyan, #4ec9b0);
    --orange: #e89a4e;
    --hover: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.31));
    --btn: var(--vscode-button-background, #0e639c);
    --btn-text: var(--vscode-button-foreground, #ffffff);
    --link: var(--vscode-textLink-foreground, #3794ff);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: 14px;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
}

.header {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
}
.header-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font-size: 16px;
    opacity: 0.7;
}
.header-icon:hover { background: var(--hover); opacity: 1; }

.tabs-container {
    display: flex;
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
}
.tab {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-right: 1px solid var(--border);
    cursor: pointer;
    white-space: nowrap;
    font-size: 14px;
}
.tab:hover { background: var(--hover); }
.tab.active { background: var(--bg); border-bottom: 2px solid var(--green); }
.tab-status {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
}
.tab.running .tab-status { background: var(--green); animation: pulse 1.5s infinite; }
.tab.stopped .tab-status { background: var(--text2); }
.tab.error .tab-status { background: var(--red); }
.tab.success .tab-status { background: var(--green); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
.tab-label { font-weight: 500; }
.tab-close {
    margin-left: 6px;
    background: none;
    border: none;
    color: var(--text2);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 4px;
}
.tab-close:hover { background: var(--red); color: #fff; }

.toolbar {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    gap: 6px;
    flex-shrink: 0;
}
.icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    transition: all 0.15s;
}
.icon-btn:hover { background: var(--hover); }
.icon-btn.stop { color: var(--red); }
.icon-btn.stop:hover { background: rgba(241, 76, 76, 0.2); }
.icon-btn.play { color: var(--green); }
.icon-btn.play:hover { background: rgba(78, 201, 176, 0.2); }
.icon-btn.ai { color: var(--blue); }
.icon-btn.ai:hover { background: rgba(86, 156, 214, 0.2); }
.icon-btn.kill-port { color: var(--orange); }
.icon-btn.kill-port:hover { background: rgba(232, 154, 78, 0.2); }
.spacer { flex: 1; }
.path { color: var(--text2); font-size: 12px; }

.node-info {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--cyan);
    padding: 10px 14px;
    background: rgba(78, 201, 176, 0.08);
    border-bottom: 1px solid var(--border);
    font-family: var(--vscode-editor-font-family, 'SF Mono', Consolas, monospace);
    font-size: 14px;
}
.node-info .switch-link {
    color: var(--link);
    cursor: pointer;
    text-decoration: none;
    opacity: 0.9;
    font-size: 13px;
    margin-left: auto;
    padding: 4px 10px;
    border-radius: 4px;
    transition: all 0.15s;
}
.node-info .switch-link:hover {
    background: var(--hover);
    opacity: 1;
    text-decoration: underline;
}

.output {
    flex: 1;
    overflow: auto;
    padding: 14px;
    font-family: var(--vscode-editor-font-family, 'SF Mono', Consolas, monospace);
    font-size: 14px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
}
.output::-webkit-scrollbar { width: 10px; }
.output::-webkit-scrollbar-track { background: var(--bg); }
.output::-webkit-scrollbar-thumb { background: rgba(121, 121, 121, 0.4); border-radius: 5px; }
.output::-webkit-scrollbar-thumb:hover { background: rgba(100, 100, 100, 0.7); }

.empty {
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text2);
    text-align: center;
    padding: 30px;
    gap: 16px;
    min-height: 0;
}
.empty-icon { font-size: 48px; opacity: 0.6; }
.empty p { font-size: 15px; line-height: 1.6; }
.empty-btn {
    padding: 12px 24px;
    background: var(--btn);
    color: var(--btn-text);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 500;
    font-size: 14px;
    margin-top: 10px;
}
.empty-btn:hover { opacity: 0.9; }

.ansi-red { color: var(--red); }
.ansi-green { color: var(--green); }
.ansi-yellow { color: var(--yellow); }
.ansi-blue { color: var(--blue); }
.ansi-magenta { color: var(--magenta); }
.ansi-cyan { color: var(--cyan); }
.ansi-white { color: var(--text); }
.ansi-bright-black { color: var(--text2); }
.ansi-bold { font-weight: bold; }
.ansi-dim { opacity: 0.7; }
</style>
</head>
<body>
    ${scripts.length > 0 ? `
        <div class="header">
            <button class="header-icon" onclick="showScripts()" title="Browse all scripts">☰</button>
        </div>
        <div class="tabs-container">${tabsHtml}</div>
        ${toolbarHtml}
        ${activeScript ? `
            <div class="node-info">
                <span>Node ${this.esc(nodeVersionDisplay)} • npm run ${this.esc(activeScript.name)}</span>
                <a class="switch-link" onclick="switchNodeVersion('${activeScript.id}')">Switch Node</a>
            </div>
        ` : ''}
        <div class="output" id="output">${outputHtml}</div>
    ` : `
        <div class="empty">
            <div class="empty-icon">🔥</div>
            <p>No scripts running</p>
            <p>Click a ▶ Run button in package.json<br/>or browse all available scripts</p>
            <button class="empty-btn" onclick="showScripts()">Browse Scripts</button>
        </div>
    `}
    <script>
        const vscode = acquireVsCodeApi();
        const stop = id => vscode.postMessage({cmd:'stop',id});
        const restart = id => vscode.postMessage({cmd:'restart',id});
        const remove = id => vscode.postMessage({cmd:'remove',id});
        const clear = id => vscode.postMessage({cmd:'clear',id});
        const selectTab = id => vscode.postMessage({cmd:'selectTab',id});
        const askAI = id => vscode.postMessage({cmd:'askAI',id});
        const showScripts = () => vscode.postMessage({cmd:'showScripts'});
        const killPort = port => vscode.postMessage({cmd:'killPort',port});
        const switchNodeVersion = id => vscode.postMessage({cmd:'switchNodeVersion',id});

        const outputEl = document.getElementById('output');

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.cmd === 'output' && outputEl) {
                outputEl.innerHTML += convertAnsi(msg.data);
                outputEl.scrollTop = outputEl.scrollHeight;
            }
        });

        function convertAnsi(text) {
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\\x1b\\[0m/g, '</span>')
                .replace(/\\x1b\\[1m/g, '<span class="ansi-bold">')
                .replace(/\\x1b\\[2m/g, '<span class="ansi-dim">')
                .replace(/\\x1b\\[31m/g, '<span class="ansi-red">')
                .replace(/\\x1b\\[32m/g, '<span class="ansi-green">')
                .replace(/\\x1b\\[33m/g, '<span class="ansi-yellow">')
                .replace(/\\x1b\\[34m/g, '<span class="ansi-blue">')
                .replace(/\\x1b\\[35m/g, '<span class="ansi-magenta">')
                .replace(/\\x1b\\[36m/g, '<span class="ansi-cyan">')
                .replace(/\\x1b\\[37m/g, '<span class="ansi-white">')
                .replace(/\\x1b\\[90m/g, '<span class="ansi-bright-black">')
                .replace(/\\x1b\\[91m/g, '<span class="ansi-red">')
                .replace(/\\x1b\\[92m/g, '<span class="ansi-green">')
                .replace(/\\x1b\\[93m/g, '<span class="ansi-yellow">')
                .replace(/\\x1b\\[94m/g, '<span class="ansi-blue">')
                .replace(/\\x1b\\[95m/g, '<span class="ansi-magenta">')
                .replace(/\\x1b\\[96m/g, '<span class="ansi-cyan">')
                .replace(/\\x1b\\[97m/g, '<span class="ansi-white">');
        }

        if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
    </script>
</body>
</html>`;
    }

    private ansiToHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\x1b\[0m/g, '</span>')
            .replace(/\x1b\[1m/g, '<span class="ansi-bold">')
            .replace(/\x1b\[2m/g, '<span class="ansi-dim">')
            .replace(/\x1b\[31m/g, '<span class="ansi-red">')
            .replace(/\x1b\[32m/g, '<span class="ansi-green">')
            .replace(/\x1b\[33m/g, '<span class="ansi-yellow">')
            .replace(/\x1b\[34m/g, '<span class="ansi-blue">')
            .replace(/\x1b\[35m/g, '<span class="ansi-magenta">')
            .replace(/\x1b\[36m/g, '<span class="ansi-cyan">')
            .replace(/\x1b\[37m/g, '<span class="ansi-white">')
            .replace(/\x1b\[90m/g, '<span class="ansi-bright-black">')
            .replace(/\x1b\[91m/g, '<span class="ansi-red">')
            .replace(/\x1b\[92m/g, '<span class="ansi-green">')
            .replace(/\x1b\[93m/g, '<span class="ansi-yellow">')
            .replace(/\x1b\[94m/g, '<span class="ansi-blue">')
            .replace(/\x1b\[95m/g, '<span class="ansi-magenta">')
            .replace(/\x1b\[96m/g, '<span class="ansi-cyan">')
            .replace(/\x1b\[97m/g, '<span class="ansi-white">');
    }

    private esc(s: string): string {
        return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]||c));
    }
}
