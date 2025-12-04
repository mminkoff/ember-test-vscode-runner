import * as vscode from 'vscode';
import * as fs from 'fs';
import { parse, ParseResult } from '@babel/parser';
import { File } from '@babel/types';

let debugMode = false;
let outputChannel: vscode.OutputChannel;

interface TestNode {
	type: 'test' | 'module';
	name: string;
	position: number;
	children?: TestNode[];
}

// Create a helper function for logging
function log(message: string, level: 'info' | 'error' | 'debug' = 'info'): void {
	const prefix = '[EmberTestRunner]';
	const logMessage = `${prefix} ${message}`;
	
	// Only log if outputChannel is initialized
	if (!outputChannel) {
		console.log(`${level.toUpperCase()}: ${logMessage} (outputChannel not initialized)`);
		return;
	}
	
	// Log to output channel
	outputChannel.appendLine(`${level.toUpperCase()}: ${logMessage}`);
	
	// Also log to console for extension development
	switch(level) {
		case 'info':
			console.log(logMessage);
			break;
		case 'error':
			console.error(logMessage);
			break;
		case 'debug':
			console.debug(logMessage);
			break;
	}
	
	// Optionally write logs to a file for persistent debugging
	// fs.appendFileSync('/path/to/log/file.log', `${new Date().toISOString()} ${prefix} ${level.toUpperCase()}: ${message}\n`);
}

// This function activates the extension
export function activate(context: vscode.ExtensionContext) {
	// Create output channel
	outputChannel = vscode.window.createOutputChannel('Ember Test Runner');
	context.subscriptions.push(outputChannel);
	
	// Get global storage path and ensure it exists
	const globalStoragePath = context.globalStorageUri.fsPath;
	try {
		if (!fs.existsSync(globalStoragePath)) {
			fs.mkdirSync(globalStoragePath, { recursive: true });
			log(`Created global storage directory: ${globalStoragePath}`, 'info');
		}
	} catch (error) {
		log(`Failed to create global storage directory: ${error instanceof Error ? error.message : String(error)}`, 'error');
	}
	
	// Get settings
	const config = vscode.workspace.getConfiguration('emberTestRunner');
	debugMode = config.get('debug', false);
	
	log(`Ember Test Runner is now active (Debug: ${debugMode ? 'enabled' : 'disabled'})`);
	
	// Register a command to toggle debug mode
	context.subscriptions.push(
		vscode.commands.registerCommand('ember-test-runner.toggleDebug', () => {
			debugMode = !debugMode;
			config.update('debug', debugMode, true);
			log(`Debug mode ${debugMode ? 'enabled' : 'disabled'}`);
		})
	);

	// Register the CodeLens provider
	const codeLensProvider = new EmberTestCodeLensProvider();
	const selector = [
		{ language: 'javascript', pattern: '**/*test.js' },
		{ language: 'typescript', pattern: '**/*test.ts' },
		{ scheme: 'file', pattern: '**/*test.gjs' },
		{ scheme: 'file', pattern: '**/*test.gts' },
		// Also register for files that might be detected as different language types
		{ pattern: '**/*test.gjs' },
		{ pattern: '**/*test.gts' }
	];
	
	context.subscriptions.push(
			vscode.languages.registerCodeLensProvider(selector, codeLensProvider)
	);
	
	// Helper function to build test runner URL
	function buildTestRunnerUrl(filter: string, filePath: string): string {
		const config = vscode.workspace.getConfiguration('emberTestRunner');
		const testRunnerBaseUrl = config.get('testRunnerBaseUrl', 'http://localhost:4200/tests');
		const hidePassed = config.get('hidePassed', true);
		const fileName = filePath.split('/').pop() || '';
		
		const queryParams = [];
		if (hidePassed) queryParams.push('hidepassed');
		queryParams.push(`filter=${encodeURIComponent(filter)}`);
		queryParams.push(`file=${encodeURIComponent(fileName)}`);
		
		return `${testRunnerBaseUrl}?${queryParams.join('&')}`;
	}
	
	// Register commands
	context.subscriptions.push(
			vscode.commands.registerCommand('ember-test-runner.runModuleTests', (moduleName: string, filePath: string) => {
					// moduleName already contains the full path with nested modules joined by " > "
					const fileName = filePath.split('/').pop() || '';
					const url = buildTestRunnerUrl(moduleName, filePath);
					log(`Running module tests for ${moduleName} from file ${fileName} at ${url}`, 'debug');
					vscode.env.openExternal(vscode.Uri.parse(url));
			})
	);
	
	context.subscriptions.push(
			vscode.commands.registerCommand('ember-test-runner.runSingleTest', (moduleName: string, testName: string, filePath: string) => {
					// Use the full module path (including parent modules) for uniqueness
					const filter = `${moduleName}: ${testName}`;
					const fileName = filePath.split('/').pop() || '';
					const url = buildTestRunnerUrl(filter, filePath);
					log(`Running test "${testName}" in module "${moduleName}" from file ${fileName} with filter: ${filter}`, 'debug');
					vscode.env.openExternal(vscode.Uri.parse(url));
			})
	);
}

// This class provides CodeLens items for test modules and individual tests
class EmberTestCodeLensProvider implements vscode.CodeLensProvider {
	private moduleTestMap: Map<string, string[]> = new Map();
	
	public async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		try {
			// Always log that this method was called - regardless of debug mode
			log(`provideCodeLenses called for: ${document.fileName} (languageId: ${document.languageId})`, 'info');
			
			// Clear any previous mappings
			this.moduleTestMap.clear();
			
			const codeLenses: vscode.CodeLens[] = [];
			const text = document.getText();
			
			let testPaths: { name: string; position: number }[] = [];
			let modulePaths: { name: string; position: number }[] = [];
			
			if (debugMode) {
				log(`Processing file: ${document.fileName} (languageId: ${document.languageId})`, 'debug');
			}
			
			// Check if this is a GJS or GTS file
			if (document.fileName.endsWith('.gjs') || document.fileName.endsWith('.gts')) {
				if (debugMode) {
					log(`Detected GJS/GTS file: ${document.fileName}`, 'debug');
				}
				[testPaths, modulePaths] = await this.extractGlimmerModulesAndTests(text);
			} else {
				if (debugMode) {
					log(`Processing as JS/TS file: ${document.fileName}`, 'debug');
				}
				// Use Babel for JS/TS files
				[testPaths, modulePaths] = this.extractModulesAndTests(text);
			}
			
			// Build the module test map
			for (const moduleInfo of modulePaths) {
				const moduleName = moduleInfo.name;
				this.moduleTestMap.set(moduleName, []);
			}
			
			// Add tests to their respective modules
			for (const testInfo of testPaths) {
				const testPath = testInfo.name;
				// Extract module name (everything before the colon) and test name (everything after)
				const colonIndex = testPath.lastIndexOf(': ');
				if (colonIndex !== -1) {
					const moduleName = testPath.substring(0, colonIndex);
					const testName = testPath.substring(colonIndex + 2);
					
					// Add the test to its module
					const tests = this.moduleTestMap.get(moduleName) || [];
					tests.push(testName);
					this.moduleTestMap.set(moduleName, tests);
				}
			}
			
			// Create code lenses for module definitions
			for (const moduleInfo of modulePaths) {
				codeLenses.push(this.createCodeLens(
					document,
					moduleInfo.position,
					"▶ Run Module Tests",
					"ember-test-runner.runModuleTests",
					[moduleInfo.name, document.fileName]
				));
			}
			
			// Create code lenses for test definitions
			for (const testInfo of testPaths) {
				const testPath = testInfo.name;
				const colonIndex = testPath.lastIndexOf(': ');
				
				if (colonIndex !== -1) {
					const moduleName = testPath.substring(0, colonIndex);
					const testName = testPath.substring(colonIndex + 2);
					
					codeLenses.push(this.createCodeLens(
						document,
						testInfo.position,
						"▶ Run Test",
						"ember-test-runner.runSingleTest",
						[moduleName, testName, document.fileName]
					));
				}
			}
			
			log(`Created ${codeLenses.length} code lenses (${modulePaths.length} modules, ${testPaths.length} tests)`, 'info');
			return codeLenses;
		} catch (error) {
			log(`Error in provideCodeLenses: ${error instanceof Error ? error.message : String(error)}`, 'error');
			if (error instanceof Error && error.stack) {
				log(`Stack trace: ${error.stack}`, 'error');
			}
			return [];
		}
	}

	private createCodeLens(document: vscode.TextDocument, position: number, title: string, command: string, args: any[]): vscode.CodeLens {
		// Convert character position to line number
		const positionObj = document.positionAt(position);
		const line = positionObj.line;
		
		// Create range at the beginning of the line for proper alignment
		const lineStart = new vscode.Position(line, 0);
		const lineEnd = document.lineAt(line).range.end;
		const range = new vscode.Range(lineStart, lineEnd);
		
		if (debugMode) {
			log(`Creating CodeLens at line ${line} (char pos ${position}): ${title}`, 'debug');
		}
		
		return new vscode.CodeLens(range, {
			title: title,
			command: command,
			arguments: args
		});
	}

	private extractModulesAndTests(text: string): [{ name: string; position: number }[], { name: string; position: number }[]] {
		const testPaths: { name: string; position: number }[] = [];
		const modulePaths: { name: string; position: number }[] = [];
		
		try {
			// Parse the code into an AST
			const ast = parse(text, { 
				sourceType: 'module', 
				plugins: [
					'typescript', 
					'jsx', 
					'decorators-legacy',
					'functionBind',
					'exportDefaultFrom',
					'exportNamespaceFrom',
					'dynamicImport',
					'nullishCoalescingOperator',
					'optionalChaining',
					'classProperties'
				],
				allowImportExportEverywhere: true,
				allowReturnOutsideFunction: true
			});
			
			// Build the tree from AST
			const tree = this.buildTreeFromAST(ast);
			
			// Traverse the tree to extract modules and tests
			if (tree) {
				this.traverseTree(tree, '', modulePaths, testPaths);
			}
			
			if (debugMode) {
				log(`Extracted ${modulePaths.length} modules and ${testPaths.length} tests.`, 'debug');
			}
		} catch (error) {
			log(`Error parsing test file: ${error instanceof Error ? error.message : String(error)}`, 'error');
		}

		return [testPaths, modulePaths];
	}

	private findModulesInText(text: string): { name: string; position: number }[] {
		const moduleMatches: { name: string; position: number }[] = [];
		const moduleRegex = /module\s*\(\s*['"`]([^'"`]+)['"`]/g;
		let match;
		
		while ((match = moduleRegex.exec(text)) !== null) {
			moduleMatches.push({
				name: match[1],
				position: match.index
			});
			if (debugMode) {
				log(`Found module "${match[1]}" at position ${match.index}`, 'debug');
			}
		}
		
		if (debugMode) {
			log(`Module regex found ${moduleMatches.length} matches`, 'debug');
		}
		
		return moduleMatches;
	}

	private findTestsInText(text: string): { name: string; position: number }[] {
		const testMatches: { name: string; position: number }[] = [];
		// More flexible regex to handle various whitespace and formatting
		const testRegex = /test\s*\(\s*['"`]([^'"`]+)['"`]/gm;
		let match;
		
		while ((match = testRegex.exec(text)) !== null) {
			testMatches.push({
				name: match[1],
				position: match.index
			});
			if (debugMode) {
				log(`Found test "${match[1]}" at position ${match.index}`, 'debug');
			}
		}
		
		if (debugMode) {
			log(`Test regex found ${testMatches.length} matches`, 'debug');
			// Let's also try to see what the text looks like around test calls
			const testLines = text.split('\n').filter(line => line.includes('test('));
			log(`Lines containing 'test(': ${testLines.length}`, 'debug');
			testLines.forEach((line, i) => log(`  Line ${i}: ${line.trim()}`, 'debug'));
		}
		
		return testMatches;
	}

	private async extractGlimmerModulesAndTests(text: string): Promise<[{ name: string; position: number }[], { name: string; position: number }[]]> {
		const testPaths: { name: string; position: number }[] = [];
		const modulePaths: { name: string; position: number }[] = [];
		
		if (debugMode) {
			log(`Starting GJS/GTS extraction. Original text length: ${text.length}`, 'debug');
		}
		
		try {
			// For GJS/GTS files, we need to find positions in the original text
			// and properly associate tests with their modules
			const moduleMatches = this.findModulesInText(text);
			const testMatches = this.findTestsInText(text);
			
			// Convert module matches to the expected format
			moduleMatches.forEach(match => {
				modulePaths.push({
					name: match.name,
					position: match.position
				});
			});
			
			// For tests, we need to associate them with their containing module
			testMatches.forEach(testMatch => {
				// Find the closest module before this test
				let containingModule = null;
				let closestDistance = Infinity;
				
				for (const moduleMatch of moduleMatches) {
					if (moduleMatch.position < testMatch.position) {
						const distance = testMatch.position - moduleMatch.position;
						if (distance < closestDistance) {
							closestDistance = distance;
							containingModule = moduleMatch.name;
						}
					}
				}
				
				if (containingModule) {
					// Create the full test path in the expected format: "ModuleName: TestName"
					const fullTestPath = `${containingModule}: ${testMatch.name}`;
					testPaths.push({
						name: fullTestPath,
						position: testMatch.position
					});
					
					if (debugMode) {
						log(`Associated test "${testMatch.name}" with module "${containingModule}"`, 'debug');
					}
				} else {
					if (debugMode) {
						log(`Could not find containing module for test "${testMatch.name}"`, 'debug');
					}
				}
			});
			
			if (debugMode) {
				log(`GJS/GTS: Found ${modulePaths.length} modules and ${testPaths.length} tests using regex matching.`, 'debug');
				modulePaths.forEach(m => log(`  Module: "${m.name}" at position ${m.position}`, 'debug'));
				testPaths.forEach(t => log(`  Test: "${t.name}" at position ${t.position}`, 'debug'));
			}
		} catch (error) {
			log(`Error parsing GJS/GTS file: ${error instanceof Error ? error.message : String(error)}`, 'error');
		}

		return [testPaths, modulePaths];
	}

	private extractJavaScriptFromGlimmer(text: string): string {
		// Extract JavaScript content from GJS/GTS files
		// This approach handles inline templates within render() calls and standalone template blocks
		
		if (debugMode) {
			log(`Original GJS/GTS content (first 500 chars):\n${text.substring(0, 500)}...`, 'debug');
		}
		
		let jsContent = text;
		
		// Remove standalone template blocks at the end of files
		jsContent = jsContent.replace(/<template[^>]*>[\s\S]*?<\/template>\s*$/gm, '');
		
		// Handle template literals with template tags (e.g., hbs`<template>...</template>`)
		jsContent = jsContent.replace(/hbs`[\s\S]*?`/g, '');
		
		// For inline templates in render() calls, we need a different approach
		// Replace inline <template> content with a placeholder to keep the render() structure
		jsContent = jsContent.replace(
			/<template[^>]*>([\s\S]*?)<\/template>/g, 
			'<div>/* template content */</div>'
		);
		
		// Clean up any remaining template artifacts but keep the structure
		jsContent = jsContent.trim();
		
		if (debugMode) {
			log(`Extracted JavaScript content (first 500 chars):\n${jsContent.substring(0, 500)}...`, 'debug');
		}
		
		return jsContent;
	}

	private mapPositionToOriginal(extractedPosition: number, originalText: string, extractedText: string): number {
		// Since we're keeping line structure, positions should map correctly
		// This is a simplified approach - in a real implementation you'd want more sophisticated mapping
		return extractedPosition;
	}
	
	
	private buildTreeFromAST(ast: ParseResult<File>): TestNode | null {

		// Helper function to check if a function is a module
		function isModule(functionName: string): boolean {
			return ['describe', 'module', 'context'].includes(functionName);
		}
	
		function isTest(functionName: string): boolean {
			return ['it', 'test', 'specify'].includes(functionName);
		}
	
		// Process a node to build the test tree structure
		function processNode(node: any): TestNode | null {
			if (!node) return null;
	
			// Create a root module for the tree
			const rootModule: TestNode = {
				type: 'module',
				name: 'Root',
				position: 0,
				children: []
			};
	
			// If it's a program node, process all body statements
			if (node.type === 'Program') {
				node.body.forEach((statement: any) => {
					const result = processStatement(statement);
					if (result) {
						if (Array.isArray(result)) {
							rootModule.children!.push(...result);
						} else {
							rootModule.children!.push(result);
						}
					}
				});
			}
	
			// Return the root module if it has children, otherwise null
			return rootModule.children && rootModule.children.length > 0 ? rootModule : null;
		}
	
		// Process a statement (expression or declaration)
		function processStatement(node: any): TestNode | null | TestNode[] {
			if (!node) return null;
	
			// For expression statements (most test framework calls)
			if (node.type === 'ExpressionStatement') {
				return processExpression(node.expression, node.start);
			}
			
			// Handle loops that might contain test calls
			if (node.type === 'ForStatement' || 
				node.type === 'ForInStatement' || 
				node.type === 'ForOfStatement' || 
				node.type === 'WhileStatement' || 
				node.type === 'DoWhileStatement') {
				
				if (node.body && node.body.type === 'BlockStatement') {
					const results: TestNode[] = [];
					node.body.body.forEach((statement: any) => {
						const result = processStatement(statement);
						if (result) {
							if (Array.isArray(result)) {
								results.push(...result);
							} else {
								results.push(result);
							}
						}
					});
					return results.length > 0 ? results : null;
				}
			}
			
			// Handle array methods with callbacks that might contain test calls (.forEach, .map, etc.)
			if (node.type === 'ExpressionStatement' && 
				node.expression.type === 'CallExpression' && 
				node.expression.callee.type === 'MemberExpression') {
				
				const methodName = node.expression.callee.property.type === 'Identifier' ? 
					node.expression.callee.property.name : '';
				
				if (['forEach', 'map', 'filter', 'every', 'some'].includes(methodName) && 
					node.expression.arguments.length > 0) {
					
					const callback = node.expression.arguments[0];
					if ((callback.type === 'ArrowFunctionExpression' || 
						callback.type === 'FunctionExpression') && 
						callback.body.type === 'BlockStatement') {
						
						const results: TestNode[] = [];
						callback.body.body.forEach((statement: any) => {
							const result = processStatement(statement);
							if (result) {
								if (Array.isArray(result)) {
									results.push(...result);
								} else {
									results.push(result);
								}
							}
						});
						return results.length > 0 ? results : null;
					}
				}
			}
	
			return null;
		}
	
		// Process expressions (function calls)
		function processExpression(node: any, position: number): TestNode | null | TestNode[] {
			if (!node) return null;
	
			// Check for call expressions (function calls like describe(), it())
			if (node.type === 'CallExpression') {
				const callee = node.callee;
				
				// Get the function name
				let functionName = '';
				if (callee.type === 'Identifier') {
					functionName = callee.name;
				} else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
					functionName = callee.property.name;
				}
	
				// Check if it's a module function
				if (isModule(functionName) && node.arguments.length > 0) {
					const firstArg = node.arguments[0];
					let moduleName = '';
					
					// Extract module name from string literal
					if (firstArg.type === 'StringLiteral') {
						moduleName = firstArg.value;
					} else if (firstArg.type === 'TemplateLiteral' && firstArg.quasis.length > 0) {
						// Handle template literals for module names
						moduleName = firstArg.quasis[0].value.cooked;
					}
	
					// Process the callback function for nested tests/modules
					const children: TestNode[] = [];
					if (node.arguments.length > 1) {
						const callback = node.arguments[1];
						if (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') {
							if (callback.body.type === 'BlockStatement') {
								callback.body.body.forEach((statement: any) => {
									const result = processStatement(statement);
									if (result) {
										if (Array.isArray(result)) {
											children.push(...result);
										} else {
											children.push(result);
										}
									}
								});
							}
						}
					}
	
					return {
						type: 'module',
						name: moduleName,
						position: position || node.start || 0,
						children
					};
				}
	
				// Check if it's a test function
				if (isTest(functionName) && node.arguments.length > 0) {
					const firstArg = node.arguments[0];
					let testName = '';
					
					// Extract test name from string literal
					if (firstArg.type === 'StringLiteral') {
						testName = firstArg.value;
					} else if (firstArg.type === 'TemplateLiteral') {
						// Handle template literals for test names, only keep the part before the variable
						testName = firstArg.quasis[0].value.cooked;
					}
	
					return {
						type: 'test',
						name: testName,
						position: position || node.start || 0
					};
				}
				
				// Handle array methods with callbacks that might contain test calls
				if (callee.type === 'MemberExpression' && 
					callee.property.type === 'Identifier' && 
					['forEach', 'map', 'filter', 'every', 'some'].includes(callee.property.name) && 
					node.arguments.length > 0) {
					
					const callback = node.arguments[0];
					if ((callback.type === 'ArrowFunctionExpression' || 
						callback.type === 'FunctionExpression') && 
						callback.body.type === 'BlockStatement') {
						
						const results: TestNode[] = [];
						callback.body.body.forEach((statement: any) => {
							const result = processStatement(statement);
							if (result) {
								if (Array.isArray(result)) {
									results.push(...result);
								} else {
									results.push(result);
								}
							}
						});
						return results.length > 0 ? results : null;
					}
				}
			}
	
			return null;
		}
	
		return processNode(ast.program);
	}
	
	private traverseTree(
		node: TestNode,
		prefix: string,
		modules: { name: string; position: number }[],
		tests: { name: string; position: number }[]
	): void {
		if (node.type === 'module') {
			// Skip the root module, process its children directly
			if (node.name === 'Root' && node.children) {
				node.children.forEach((child) => this.traverseTree(child, '', modules, tests));
				return;
			}
			
			// For other modules, create full path and add to modules
			const moduleName = prefix ? `${prefix} > ${node.name}` : node.name;
			modules.push({
				name: moduleName,
				position: node.position,
			});
			
			if (debugMode) {
				log(`Found module: "${moduleName}" at position ${node.position}`, 'debug');
			}
			
			// Process all children with updated prefix
			node.children?.forEach((child) => this.traverseTree(child, moduleName, modules, tests));
		} else if (node.type === 'test') {
			// Only add tests that have a module prefix
			if (prefix) {
				const testPath = `${prefix}: ${node.name}`;
				tests.push({
					name: testPath,
					position: node.position,
				});
				
				if (debugMode) {
					log(`Found test: "${testPath}" at position ${node.position}`, 'debug');
				}
			}
		}
	}
}

// This method is called when your extension is deactivated
export function deactivate() {}
