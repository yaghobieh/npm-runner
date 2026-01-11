import * as vscode from 'vscode';

export class ScriptCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.fileName.endsWith('package.json')) {
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] | null {
        if (!document.fileName.endsWith('package.json')) {
            return null;
        }

        const codeLenses: vscode.CodeLens[] = [];
        const text = document.getText();

        try {
            const pkg = JSON.parse(text);
            const scripts = pkg.scripts;

            if (!scripts) return codeLenses;

            const scriptsMatch = text.match(/"scripts"\s*:\s*\{[^}]*\}/s);
            if (!scriptsMatch) return codeLenses;

            const scriptsStartIndex = text.indexOf(scriptsMatch[0]);
            const scriptsContent = scriptsMatch[0];

            for (const [scriptName, scriptCommand] of Object.entries(scripts)) {
                const scriptPattern = new RegExp(`"${this.escapeRegex(scriptName)}"\\s*:`);
                const match = scriptsContent.match(scriptPattern);

                if (match && match.index !== undefined) {
                    const absoluteIndex = scriptsStartIndex + match.index;
                    const position = document.positionAt(absoluteIndex);
                    const range = new vscode.Range(position, position);

                    codeLenses.push(
                        new vscode.CodeLens(range, {
                            title: '▶ Run',
                            command: 'npmRunner.runScript',
                            arguments: [scriptName, document.fileName],
                            tooltip: `Run: npm run ${scriptName}`
                        })
                    );

                    codeLenses.push(
                        new vscode.CodeLens(range, {
                            title: '🐛 Debug',
                            command: 'npmRunner.debugScript',
                            arguments: [scriptName, document.fileName],
                            tooltip: `Debug: npm run ${scriptName}`
                        })
                    );
                }
            }
        } catch (e) {
        }

        return codeLenses;
    }

    private escapeRegex(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

