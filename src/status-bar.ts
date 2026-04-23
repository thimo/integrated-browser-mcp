import * as vscode from 'vscode';
import type { CDPState } from './cdp';

export class StatusBar {
	private item: vscode.StatusBarItem;
	private everConnected = false;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'browserBridge.status';
		this.update('disconnected', false);
		this.item.show();
	}

	update(cdpState: CDPState, serverRunning: boolean, transport?: 'websocket' | 'browserTab' | null): void {
		if (cdpState === 'connected') this.everConnected = true;

		const transportTag = transport === 'browserTab' ? ' (proposed)'
			: transport === 'websocket' ? ' (debug-session)'
			: '';

		if (!serverRunning) {
			this.item.text = '$(circle-slash) Browser MCP';
			this.item.tooltip = 'Browser MCP: Off';
			this.item.backgroundColor = undefined;
		} else if (cdpState === 'connected') {
			this.item.text = '$(broadcast) Browser MCP';
			this.item.tooltip = `Browser MCP: Connected${transportTag}`;
			this.item.backgroundColor = undefined;
		} else if (cdpState === 'connecting') {
			this.item.text = '$(sync~spin) Browser MCP';
			this.item.tooltip = 'Browser MCP: Connecting...';
			this.item.backgroundColor = undefined;
		} else if (this.everConnected) {
			// Lost a previously live connection — something went wrong.
			this.item.text = '$(warning) Browser MCP';
			this.item.tooltip = 'Browser MCP: Disconnected';
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else {
			// Idle: bridge is up, just hasn't been asked to open a browser yet.
			this.item.text = '$(circle-outline) Browser MCP';
			this.item.tooltip = 'Browser MCP: Idle (no browser open)';
			this.item.backgroundColor = undefined;
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
