import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface NodeVersion {
    version: string;
    path?: string;
    isCustom?: boolean;
    isInstalled?: boolean;
    isLts?: boolean;
}

export class NodeVersionManager {
    private currentVersion: string = '';
    private customPaths: Map<string, string> = new Map();
    private scriptVersions: Map<string, string> = new Map();

    constructor(private context: vscode.ExtensionContext) {
        this.loadSavedData();
    }

    private loadSavedData(): void {
        const saved = this.context.globalState.get<Record<string, string>>('scriptNodeVersions', {});
        this.scriptVersions = new Map(Object.entries(saved));

        const customPaths = this.context.globalState.get<Record<string, string>>('customNodePaths', {});
        this.customPaths = new Map(Object.entries(customPaths));
    }

    private async saveScriptVersions(): Promise<void> {
        await this.context.globalState.update('scriptNodeVersions', Object.fromEntries(this.scriptVersions));
    }

    private async saveCustomPaths(): Promise<void> {
        await this.context.globalState.update('customNodePaths', Object.fromEntries(this.customPaths));
    }

    getScriptKey(scriptName: string, cwd: string): string {
        return `${cwd}:${scriptName}`;
    }

    async getVersionForScript(scriptName: string, cwd: string): Promise<string> {
        const key = this.getScriptKey(scriptName, cwd);
        return this.scriptVersions.get(key) || '';
    }

    async setVersionForScript(scriptName: string, cwd: string, version: string): Promise<void> {
        const key = this.getScriptKey(scriptName, cwd);
        if (version) {
            this.scriptVersions.set(key, version);
        } else {
            this.scriptVersions.delete(key);
        }
        await this.saveScriptVersions();
    }

    async getCurrentVersion(): Promise<string> {
        try {
            const { stdout } = await execAsync('node --version');
            this.currentVersion = stdout.trim();
            return this.currentVersion;
        } catch {
            return 'unknown';
        }
    }

    async getInstalledVersions(): Promise<Set<string>> {
        const installed = new Set<string>();
        try {
            const { stdout } = await execAsync(`source ~/.nvm/nvm.sh && nvm ls --no-colors`, {
                shell: '/bin/bash'
            });
            const lines = stdout.split('\n');
            for (const line of lines) {
                const match = line.match(/v(\d+\.\d+\.\d+)/);
                if (match) {
                    installed.add(match[0]);
                }
            }
        } catch {}
        return installed;
    }

    async getAvailableVersions(): Promise<NodeVersion[]> {
        const versions: NodeVersion[] = [];
        const installed = await this.getInstalledVersions();

        try {
            const { stdout } = await execAsync(`source ~/.nvm/nvm.sh && nvm ls-remote --lts --no-colors`, {
                shell: '/bin/bash',
                timeout: 15000
            });

            const lines = stdout.split('\n');
            const seen = new Set<string>();

            for (const line of lines) {
                const match = line.match(/v(\d+\.\d+\.\d+)/);
                const isLts = line.includes('->') || line.includes('LTS');
                if (match && !seen.has(match[0])) {
                    seen.add(match[0]);
                    versions.push({
                        version: match[0],
                        isInstalled: installed.has(match[0]),
                        isLts
                    });
                }
            }
        } catch {
            for (const v of installed) {
                versions.push({ version: v, isInstalled: true });
            }
        }

        versions.sort((a, b) => {
            const aParts = a.version.replace('v', '').split('.').map(Number);
            const bParts = b.version.replace('v', '').split('.').map(Number);
            for (let i = 0; i < 3; i++) {
                if (aParts[i] !== bParts[i]) {
                    return bParts[i] - aParts[i];
                }
            }
            return 0;
        });

        for (const [name, path] of this.customPaths) {
            versions.push({ version: name, path, isCustom: true, isInstalled: true });
        }

        return versions;
    }

    async installVersion(version: string): Promise<boolean> {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Installing Node ${version}...`,
                cancellable: false
            }, async () => {
                await execAsync(`source ~/.nvm/nvm.sh && nvm install ${version}`, {
                    shell: '/bin/bash',
                    timeout: 300000
                });
            });
            vscode.window.showInformationMessage(`Node ${version} installed successfully!`);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to install Node ${version}`);
            return false;
        }
    }

    async addCustomPath(name: string, path: string): Promise<boolean> {
        try {
            const { stdout } = await execAsync(`${path}/node --version`);
            const version = stdout.trim();
            this.customPaths.set(name || version, path);
            await this.saveCustomPaths();
            return true;
        } catch {
            return false;
        }
    }

    async removeCustomPath(name: string): Promise<void> {
        this.customPaths.delete(name);
        await this.saveCustomPaths();
    }

    getCustomPaths(): Map<string, string> {
        return this.customPaths;
    }

    getShellPrefix(version?: string): string {
        if (!version) return '';

        const customPath = this.customPaths.get(version);
        if (customPath) {
            return `export PATH="${customPath}:$PATH" && `;
        }

        return `source ~/.nvm/nvm.sh && nvm use ${version} > /dev/null 2>&1 && `;
    }

    async getVersionForTerminal(): Promise<string> {
        const config = vscode.workspace.getConfiguration('npmRunner');
        const defaultVersion = config.get<string>('defaultNodeVersion');
        return defaultVersion || '';
    }

    async showVersionPicker(scriptName: string, cwd: string): Promise<string | undefined> {
        const versions = await this.getAvailableVersions();
        const currentForScript = await this.getVersionForScript(scriptName, cwd);
        const systemVersion = await this.getCurrentVersion();

        const installedVersions = versions.filter(v => v.isInstalled);
        const availableVersions = versions.filter(v => !v.isInstalled && !v.isCustom);

        const items: vscode.QuickPickItem[] = [
            {
                label: '$(globe) System Default',
                description: systemVersion,
                detail: currentForScript === '' ? '$(check) Currently selected' : undefined
            }
        ];

        if (installedVersions.length > 0) {
            items.push({ label: 'Installed', kind: vscode.QuickPickItemKind.Separator });
            items.push(...installedVersions.map(v => ({
                label: v.isCustom ? `$(folder) ${v.version}` : `$(check) ${v.version}`,
                description: v.isCustom ? v.path : '✓ Installed',
                detail: currentForScript === v.version ? '$(check) Currently selected' : undefined
            })));
        }

        if (availableVersions.length > 0) {
            items.push({ label: 'Available (not installed)', kind: vscode.QuickPickItemKind.Separator });
            items.push(...availableVersions.slice(0, 20).map(v => ({
                label: `$(cloud-download) ${v.version}`,
                description: v.isLts ? 'LTS' : '',
                detail: 'Click to install'
            })));
        }

        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(add) Add Custom Path...',
            description: 'Point to a Node.js installation folder'
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select Node version for "${scriptName}"`,
            title: 'Switch Node Version'
        });

        if (!selected) return undefined;

        if (selected.label === '$(globe) System Default') {
            await this.setVersionForScript(scriptName, cwd, '');
            return '';
        }

        if (selected.label === '$(add) Add Custom Path...') {
            const folderUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                openLabel: 'Select Node.js Folder',
                title: 'Select folder containing node executable'
            });

            if (folderUri && folderUri[0]) {
                const folderPath = folderUri[0].fsPath;
                const name = await vscode.window.showInputBox({
                    prompt: 'Give this Node installation a name',
                    placeHolder: 'e.g., node-18-custom'
                });

                if (name) {
                    const success = await this.addCustomPath(name, folderPath);
                    if (success) {
                        await this.setVersionForScript(scriptName, cwd, name);
                        vscode.window.showInformationMessage(`Added custom Node path: ${name}`);
                        return name;
                    } else {
                        vscode.window.showErrorMessage(`Could not find node executable in ${folderPath}`);
                    }
                }
            }
            return undefined;
        }

        const version = selected.label.replace(/^\$\([^)]+\)\s*/, '');
        const versionInfo = versions.find(v => v.version === version);

        if (versionInfo && !versionInfo.isInstalled) {
            const install = await vscode.window.showQuickPick(['Yes, install it', 'No, cancel'], {
                placeHolder: `Node ${version} is not installed. Install it now?`,
                title: 'Install Node Version'
            });

            if (install === 'Yes, install it') {
                const success = await this.installVersion(version);
                if (success) {
                    await this.setVersionForScript(scriptName, cwd, version);
                    return version;
                }
            }
            return undefined;
        }

        await this.setVersionForScript(scriptName, cwd, version);
        return version;
    }
}
