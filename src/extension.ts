import * as vscode from 'vscode';
import * as path from 'path';
import { ScriptCodeLensProvider } from './providers/ScriptCodeLensProvider';
import { NpmRunnerPanel } from './panels/RunningScriptsPanel';
import { ScriptRunner } from './services/ScriptRunner';
import { NodeVersionManager } from './services/NodeVersionManager';
import { PackageWatcher } from './services/PackageWatcher';

let scriptRunner: ScriptRunner;
let npmRunnerPanel: NpmRunnerPanel;
let nodeVersionManager: NodeVersionManager;
let packageWatcher: PackageWatcher;

export async function activate(context: vscode.ExtensionContext) {
    nodeVersionManager = new NodeVersionManager(context);
    scriptRunner = new ScriptRunner(nodeVersionManager);
    npmRunnerPanel = new NpmRunnerPanel(context, scriptRunner, nodeVersionManager);
    packageWatcher = new PackageWatcher(context, nodeVersionManager);

    const panelProvider = vscode.window.registerWebviewViewProvider(
        NpmRunnerPanel.viewType,
        npmRunnerPanel,
        { webviewOptions: { retainContextWhenHidden: true } }
    );

    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        { pattern: '**/package.json' },
        new ScriptCodeLensProvider()
    );

    const commands = [
        vscode.commands.registerCommand('npmRunner.runScript', async (scriptName?: string, packageJsonPath?: string) => {
            await runScript(scriptName, packageJsonPath, false);
        }),

        vscode.commands.registerCommand('npmRunner.debugScript', async (scriptName?: string, packageJsonPath?: string) => {
            await runScript(scriptName, packageJsonPath, true);
        }),

        vscode.commands.registerCommand('npmRunner.showAllScripts', async () => {
            await showAllScriptsMenu();
        }),

        vscode.commands.registerCommand('npmRunner.stopScript', async (scriptId?: string) => {
            if (scriptId) {
                await scriptRunner.stopScript(scriptId);
            } else {
                const running = scriptRunner.getRunningScripts();
                if (running.length === 0) {
                    vscode.window.showInformationMessage('No scripts running');
                    return;
                }
                const items = running.map(s => ({
                    label: `${path.basename(s.cwd)}:${s.name}`,
                    id: s.id
                }));
                const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select script to stop' });
                if (selected) {
                    await scriptRunner.stopScript(selected.id);
                }
            }
        }),

        vscode.commands.registerCommand('npmRunner.restartScript', async (scriptId?: string) => {
            if (scriptId) {
                await scriptRunner.restartScript(scriptId);
            }
        }),

        vscode.commands.registerCommand('npmRunner.switchNodeVersion', async () => {
            const versions = await nodeVersionManager.getAvailableVersions();
            if (versions.length === 0) {
                vscode.window.showWarningMessage('No Node versions found. Make sure nvm is installed.');
                return;
            }

            const current = await nodeVersionManager.getCurrentVersion();
            const items = versions.map(v => ({
                label: v.version === current ? `$(check) ${v.version}` : v.isCustom ? `$(folder) ${v.version}` : `$(tag) ${v.version}`,
                description: v.isCustom ? v.path : 'nvm',
                version: v.version
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `Current: ${current}`,
                title: 'Select Node.js Version'
            });

            if (selected) {
                vscode.window.showInformationMessage(`Selected Node.js ${selected.version}. Use "Switch Node" in script panel to set per-script.`);
            }
        }),

        vscode.commands.registerCommand('npmRunner.stopAll', async () => {
            const running = scriptRunner.getRunningScripts();
            if (running.length === 0) {
                vscode.window.showInformationMessage('No scripts running');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Stop all ${running.length} running script(s)?`,
                { modal: true },
                'Stop All'
            );

            if (confirm === 'Stop All') {
                await scriptRunner.stopAll();
                vscode.window.showInformationMessage('All scripts stopped');
            }
        }),

        vscode.commands.registerCommand('npmRunner.openPanel', () => {
            vscode.commands.executeCommand('workbench.view.extension.npmRunner');
            npmRunnerPanel.reveal();
        }),
    ];

    context.subscriptions.push(panelProvider, codeLensDisposable, ...commands);

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'npmRunner.openPanel';
    statusBar.tooltip = 'NPM Runner - Click to open';
    context.subscriptions.push(statusBar);

    scriptRunner.onScriptsChanged(() => {
        const count = scriptRunner.getRunningScripts().length;
        if (count > 0) {
            statusBar.text = `$(flame) ${count}`;
            statusBar.show();
        } else {
            statusBar.hide();
        }
    });
}

async function runScript(scriptName?: string, packageJsonPath?: string, debug: boolean = false) {
    if (!scriptName || !packageJsonPath) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith('package.json')) {
            await showAllScriptsMenu();
            return;
        } else {
            packageJsonPath = editor.document.fileName;
        }

        const scripts = await getScriptsFromPackageJson(packageJsonPath);
        if (scripts.length === 0) {
            vscode.window.showInformationMessage('No scripts found in package.json');
            return;
        }

        const scriptItems = scripts.map(s => ({
            label: `$(play) ${s.name}`,
            description: s.command,
            name: s.name
        }));

        const selectedScript = await vscode.window.showQuickPick(scriptItems, {
            placeHolder: 'Select script to run'
        });

        if (!selectedScript) return;
        scriptName = selectedScript.name;
    }

    vscode.commands.executeCommand('workbench.view.extension.npmRunner');

    const scriptId = await scriptRunner.runScript(scriptName, packageJsonPath!, debug);
    npmRunnerPanel.setActiveTab(scriptId);
    npmRunnerPanel.reveal();
}

async function showAllScriptsMenu() {
    const pkgFiles = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**');
    if (pkgFiles.length === 0) {
        vscode.window.showInformationMessage('No package.json files found');
        return;
    }

    interface ScriptItem extends vscode.QuickPickItem {
        scriptName: string;
        packagePath: string;
        kind?: vscode.QuickPickItemKind;
    }

    const items: ScriptItem[] = [];

    for (const pkgFile of pkgFiles) {
        const scripts = await getScriptsFromPackageJson(pkgFile.fsPath);
        if (scripts.length === 0) continue;

        const projectName = path.basename(path.dirname(pkgFile.fsPath));

        items.push({
            label: projectName,
            kind: vscode.QuickPickItemKind.Separator,
            scriptName: '',
            packagePath: ''
        });

        for (const script of scripts) {
            items.push({
                label: `$(play) ${script.name}`,
                description: script.command.length > 50 ? script.command.substring(0, 50) + '...' : script.command,
                detail: `${projectName}`,
                scriptName: script.name,
                packagePath: pkgFile.fsPath
            });
        }
    }

    const quickPick = vscode.window.createQuickPick<ScriptItem>();
    quickPick.items = items;
    quickPick.placeholder = 'Search and select script to run';
    quickPick.title = 'NPM Scripts';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    quickPick.buttons = [
        { iconPath: new vscode.ThemeIcon('debug-start'), tooltip: 'Debug selected script' }
    ];

    quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (selected && selected.scriptName) {
            quickPick.hide();
            runScript(selected.scriptName, selected.packagePath, false);
        }
    });

    quickPick.onDidTriggerButton(() => {
        const selected = quickPick.selectedItems[0];
        if (selected && selected.scriptName) {
            quickPick.hide();
            runScript(selected.scriptName, selected.packagePath, true);
        }
    });

    quickPick.show();
}

async function getScriptsFromPackageJson(pkgPath: string): Promise<Array<{ name: string; command: string }>> {
    try {
        const doc = await vscode.workspace.openTextDocument(pkgPath);
        const pkg = JSON.parse(doc.getText());
        const scripts = pkg.scripts || {};
        return Object.entries(scripts).map(([name, command]) => ({
            name,
            command: command as string
        }));
    } catch {
        return [];
    }
}

export function deactivate() {
    if (scriptRunner) {
        scriptRunner.stopAll();
    }
    if (packageWatcher) {
        packageWatcher.dispose();
    }
}
