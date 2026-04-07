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
			this.item.text = '$(circle-slash) Browser Bridge';
			this.item.tooltip = 'Browser Bridge: Off';
			this.item.color = undefined;
		} else if (cdpState === 'connected') {
			this.item.text = '$(broadcast) Browser Bridge';
			this.item.tooltip = 'Browser Bridge: Connected';
			this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
		} else if (cdpState === 'connecting') {
			this.item.text = '$(sync~spin) Browser Bridge';
			this.item.tooltip = 'Browser Bridge: Connecting...';
			this.item.color = undefined;
		} else {
			this.item.text = '$(warning) Browser Bridge';
			this.item.tooltip = 'Browser Bridge: Disconnected';
			this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
