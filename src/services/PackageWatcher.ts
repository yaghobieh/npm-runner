import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { NodeVersionManager } from './NodeVersionManager';
import { exec } from 'child_process';

interface PackageDeps {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
}

export class PackageWatcher {
    private watcher: vscode.FileSystemWatcher;
    private depsCache: Map<string, PackageDeps> = new Map();
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor(
        private context: vscode.ExtensionContext,
        private nodeVersionManager: NodeVersionManager
    ) {
        this.watcher = vscode.workspace.createFileSystemWatcher('**/package.json');
        
        this.watcher.onDidChange(uri => this.handleChange(uri));
        this.watcher.onDidCreate(uri => this.cachePackage(uri.fsPath));
        
        this.initCache();
        
        context.subscriptions.push(this.watcher);
    }

    private async initCache(): Promise<void> {
        const files = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**');
        for (const file of files) {
            this.cachePackage(file.fsPath);
        }
    }

    private cachePackage(pkgPath: string): void {
        try {
            const content = fs.readFileSync(pkgPath, 'utf-8');
            const pkg = JSON.parse(content);
            this.depsCache.set(pkgPath, {
                dependencies: pkg.dependencies || {},
                devDependencies: pkg.devDependencies || {}
            });
        } catch {}
    }

    private handleChange(uri: vscode.Uri): void {
        const pkgPath = uri.fsPath;
        
        const existingTimer = this.debounceTimers.get(pkgPath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        
        const timer = setTimeout(() => {
            this.checkChanges(pkgPath);
            this.debounceTimers.delete(pkgPath);
        }, 500);
        
        this.debounceTimers.set(pkgPath, timer);
    }

    private async checkChanges(pkgPath: string): Promise<void> {
        const oldDeps = this.depsCache.get(pkgPath);
        if (!oldDeps) {
            this.cachePackage(pkgPath);
            return;
        }

        try {
            const content = fs.readFileSync(pkgPath, 'utf-8');
            const pkg = JSON.parse(content);
            const newDeps: PackageDeps = {
                dependencies: pkg.dependencies || {},
                devDependencies: pkg.devDependencies || {}
            };

            const changes = this.findChanges(oldDeps, newDeps);
            
            if (changes.length > 0) {
                this.depsCache.set(pkgPath, newDeps);
                await this.showInstallPrompt(pkgPath, changes);
            }
        } catch {}
    }

    private findChanges(oldDeps: PackageDeps, newDeps: PackageDeps): string[] {
        const changes: string[] = [];
        
        const checkDiff = (oldObj: Record<string, string>, newObj: Record<string, string>, type: string) => {
            const oldKeys = new Set(Object.keys(oldObj));
            const newKeys = new Set(Object.keys(newObj));
            
            for (const key of newKeys) {
                if (!oldKeys.has(key)) {
                    changes.push(`+ ${key}@${newObj[key]} (${type})`);
                } else if (oldObj[key] !== newObj[key]) {
                    changes.push(`↑ ${key}: ${oldObj[key]} → ${newObj[key]} (${type})`);
                }
            }
            
            for (const key of oldKeys) {
                if (!newKeys.has(key)) {
                    changes.push(`- ${key} (${type})`);
                }
            }
        };
        
        checkDiff(oldDeps.dependencies, newDeps.dependencies, 'dep');
        checkDiff(oldDeps.devDependencies, newDeps.devDependencies, 'devDep');
        
        return changes;
    }

    private async showInstallPrompt(pkgPath: string, changes: string[]): Promise<void> {
        const projectName = path.basename(path.dirname(pkgPath));
        const cwd = path.dirname(pkgPath);
        
        const changesList = changes.slice(0, 5).join('\n');
        const moreText = changes.length > 5 ? `\n...and ${changes.length - 5} more` : '';
        
        const selection = await vscode.window.showInformationMessage(
            `📦 ${projectName}: Dependencies changed`,
            {
                modal: false,
                detail: `${changesList}${moreText}`
            },
            'Install',
            'Install with Node...',
            'Dismiss'
        );

        if (selection === 'Install') {
            await this.runInstall(cwd);
        } else if (selection === 'Install with Node...') {
            await this.runInstallWithVersionPicker(cwd, projectName);
        }
    }

    private async runInstall(cwd: string): Promise<void> {
        const terminal = vscode.window.createTerminal({
            name: 'npm install',
            cwd
        });
        terminal.sendText('npm install');
        terminal.show();
    }

    private async runInstallWithVersionPicker(cwd: string, projectName: string): Promise<void> {
        const versions = await this.nodeVersionManager.getAvailableVersions();
        const currentVersion = await this.nodeVersionManager.getCurrentVersion();
        
        const installedVersions = versions.filter(v => v.isInstalled);
        
        const items: vscode.QuickPickItem[] = [
            {
                label: '$(globe) System Default',
                description: currentVersion
            }
        ];

        if (installedVersions.length > 0) {
            items.push({ label: 'Installed', kind: vscode.QuickPickItemKind.Separator });
            items.push(...installedVersions.map(v => ({
                label: v.isCustom ? `$(folder) ${v.version}` : `$(check) ${v.version}`,
                description: v.isCustom ? v.path : '✓ Installed'
            })));
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select Node version for npm install in ${projectName}`,
            title: 'Install Dependencies'
        });

        if (!selected) return;

        let shellPrefix = '';
        if (selected.label !== '$(globe) System Default') {
            const version = selected.label.replace(/^\$\([^)]+\)\s*/, '');
            shellPrefix = this.nodeVersionManager.getShellPrefix(version);
        }

        const terminal = vscode.window.createTerminal({
            name: `npm install (${projectName})`,
            cwd
        });
        
        if (shellPrefix) {
            terminal.sendText(`${shellPrefix}npm install`);
        } else {
            terminal.sendText('npm install');
        }
        terminal.show();
    }

    dispose(): void {
        this.watcher.dispose();
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
    }
}

