import * as vscode from 'vscode';
import type { CDPState } from './cdp';

export class StatusBar {
	private item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'browserBridge.status';
		this.update('disconnected', false);
		this.item.show();
	}

	update(cdpState: CDPState, serverRunning: boolean): void {
		if (!serverRunning) {
			this.item.text = '$(circle-slash) Browser MCP';
			this.item.tooltip = 'Browser MCP: Off';
			this.item.color = undefined;
		} else if (cdpState === 'connected') {
			this.item.text = '$(broadcast) Browser MCP';
			this.item.tooltip = 'Browser MCP: Connected';
			this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
		} else if (cdpState === 'connecting') {
			this.item.text = '$(sync~spin) Browser MCP';
			this.item.tooltip = 'Browser MCP: Connecting...';
			this.item.color = undefined;
		} else {
			this.item.text = '$(warning) Browser MCP';
			this.item.tooltip = 'Browser MCP: Disconnected';
			this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
