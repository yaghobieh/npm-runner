import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { NodeVersionManager } from './NodeVersionManager';

export interface RunningScript {
    id: string;
    name: string;
    command: string;
    packageJsonPath: string;
    cwd: string;
    process: ChildProcess | null;
    startTime: Date;
    output: string[];
    status: 'running' | 'stopped' | 'error' | 'success';
    debug: boolean;
    exitCode: number | null;
    nodeVersion: string;
    selectedNodeVersion: string;
    port: string | null;
}

export class ScriptRunner {
    private runningScripts: Map<string, RunningScript> = new Map();
    private _onScriptsChanged: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onScriptsChanged: vscode.Event<void> = this._onScriptsChanged.event;
    
    private _onOutput: vscode.EventEmitter<{ id: string; data: string }> = new vscode.EventEmitter();
    public readonly onOutput: vscode.Event<{ id: string; data: string }> = this._onOutput.event;

    constructor(private nodeVersionManager: NodeVersionManager) {}

    async runScript(scriptName: string, packageJsonPath: string, debug: boolean = false, overrideNodeVersion?: string): Promise<string> {
        const id = `${scriptName}-${Date.now()}`;
        const cwd = path.dirname(packageJsonPath);
        
        const savedVersion = overrideNodeVersion ?? await this.nodeVersionManager.getVersionForScript(scriptName, cwd);
        const shellPrefix = this.nodeVersionManager.getShellPrefix(savedVersion);
        
        let nodeVersion = savedVersion || await this.nodeVersionManager.getCurrentVersion() || 'system';

        const script: RunningScript = {
            id,
            name: scriptName,
            command: `npm run ${scriptName}`,
            packageJsonPath,
            cwd,
            process: null,
            startTime: new Date(),
            output: [],
            status: 'running',
            debug,
            exitCode: null,
            nodeVersion,
            selectedNodeVersion: savedVersion,
            port: null
        };

        this.runningScripts.set(id, script);
        this._onScriptsChanged.fire();

        const fullCommand = `${shellPrefix}npm run ${scriptName}`;

        const child = spawn('bash', ['-c', fullCommand], {
            cwd,
            env: { ...process.env, FORCE_COLOR: '1' },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        script.process = child;

        child.stdout?.on('data', (data: Buffer) => {
            this.appendOutput(id, data.toString());
        });

        child.stderr?.on('data', (data: Buffer) => {
            this.appendOutput(id, data.toString());
        });

        child.on('close', (code) => {
            script.exitCode = code;
            script.status = code === 0 ? 'success' : 'error';
            script.process = null;
            
            const statusIcon = code === 0 ? '✅' : '❌';
            const statusColor = code === 0 ? '\x1b[32m' : '\x1b[31m';
            this.appendOutput(id, `\n${statusColor}${statusIcon} Process exited with code ${code}\x1b[0m\n`);
            
            this._onScriptsChanged.fire();
        });

        child.on('error', (err) => {
            script.status = 'error';
            this.appendOutput(id, `\n\x1b[31m❌ Error: ${err.message}\x1b[0m\n`);
            this._onScriptsChanged.fire();
        });

        return id;
    }

    private appendOutput(id: string, data: string): void {
        const script = this.runningScripts.get(id);
        if (script) {
            script.output.push(data);
            
            if (!script.port) {
                const port = this.detectPort(data);
                if (port) {
                    script.port = port;
                    this._onScriptsChanged.fire();
                }
            }
            
            this._onOutput.fire({ id, data });
        }
    }

    private detectPort(text: string): string | null {
        const patterns = [
            /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/i,
            /port[:\s]+(\d{4,5})/i,
            /listening[^\d]*(\d{4,5})/i,
            /running[^\d]*(?:at|on)[^\d]*(\d{4,5})/i,
            /server[^\d]*(?:at|on)[^\d]*(\d{4,5})/i,
            /http:\/\/[^:]+:(\d{4,5})/i,
            /started[^\d]*(?:at|on)[^\d]*(\d{4,5})/i
        ];
        
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                const port = parseInt(match[1]);
                if (port >= 1000 && port <= 65535) {
                    return match[1];
                }
            }
        }
        return null;
    }

    async stopScript(id: string): Promise<void> {
        const script = this.runningScripts.get(id);
        if (!script) return;

        if (script.process) {
            script.process.kill('SIGTERM');
            setTimeout(() => {
                if (script.process) {
                    script.process.kill('SIGKILL');
                }
            }, 2000);
        }

        script.status = 'stopped';
        this.appendOutput(id, '\n\x1b[33m⏹ Process stopped\x1b[0m\n');
        this._onScriptsChanged.fire();
    }

    async restartScript(id: string): Promise<void> {
        const script = this.runningScripts.get(id);
        if (!script) return;

        const { name, packageJsonPath, debug, selectedNodeVersion } = script;

        await this.stopScript(id);
        await new Promise(resolve => setTimeout(resolve, 500));
        
        this.runningScripts.delete(id);

        await this.runScript(name, packageJsonPath, debug, selectedNodeVersion);
    }

    async updateScriptNodeVersion(id: string, newVersion: string): Promise<void> {
        const script = this.runningScripts.get(id);
        if (!script) return;

        await this.nodeVersionManager.setVersionForScript(script.name, script.cwd, newVersion);
        script.selectedNodeVersion = newVersion;
        script.nodeVersion = newVersion || 'system';
        
        this._onScriptsChanged.fire();
    }

    async stopAll(): Promise<void> {
        for (const id of this.runningScripts.keys()) {
            await this.stopScript(id);
        }
    }

    getRunningScripts(): RunningScript[] {
        return Array.from(this.runningScripts.values()).filter(s => s.status === 'running');
    }

    getAllScripts(): RunningScript[] {
        return Array.from(this.runningScripts.values());
    }

    getScript(id: string): RunningScript | undefined {
        return this.runningScripts.get(id);
    }

    removeScript(id: string): void {
        const script = this.runningScripts.get(id);
        if (script?.process) {
            script.process.kill('SIGKILL');
        }
        this.runningScripts.delete(id);
        this._onScriptsChanged.fire();
    }

    clearOutput(id: string): void {
        const script = this.runningScripts.get(id);
        if (script) {
            script.output = [];
            this._onScriptsChanged.fire();
        }
    }
}
