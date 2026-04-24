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

	update(
		cdpState: CDPState,
		serverRunning: boolean,
		transport?: 'websocket' | 'browserTab' | null,
		tabs: { count: number; activeUrl?: string } = { count: 0 },
	): void {
		const transportTag = transport === 'browserTab' ? ' (proposed)'
			: transport === 'websocket' ? ' (debug-session)'
			: '';
		const countSuffix = tabs.count > 1 ? ` (${tabs.count})` : '';
		const activeUrlLine = tabs.activeUrl ? `\nActive: ${tabs.activeUrl}` : '';
		const tabLine = tabs.count > 1 ? `\n${tabs.count} tabs open` : '';

		if (!serverRunning) {
			this.item.text = '$(circle-slash) Browser MCP';
			this.item.tooltip = 'Browser MCP: Off';
			this.item.backgroundColor = undefined;
			this.item.color = undefined;
		} else if (cdpState === 'connected') {
			this.item.text = `$(broadcast) Browser MCP${countSuffix}`;
			this.item.tooltip = `Browser MCP: Connected${transportTag}${activeUrlLine}${tabLine}`;
			this.item.backgroundColor = undefined;
			this.item.color = undefined;
		} else if (cdpState === 'connecting') {
			this.item.text = '$(sync~spin) Browser MCP';
			this.item.tooltip = 'Browser MCP: Connecting...';
			this.item.backgroundColor = undefined;
			this.item.color = undefined;
		} else if (tabs.count > 0) {
			// Tabs exist but none is connected — the CDP link dropped
			// unexpectedly. Warn so the user knows.
			this.item.text = '$(warning) Browser MCP';
			this.item.tooltip = `Browser MCP: Disconnected${tabLine}`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
		} else {
			// Idle: bridge is up, no tabs open. Not an error state.
			this.item.text = '$(circle-outline) Browser MCP';
			this.item.tooltip = 'Browser MCP: Idle (no browser tabs)';
			this.item.backgroundColor = undefined;
			this.item.color = undefined;
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
