/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as pfs from 'vs/base/node/pfs';
import * as platform from 'vs/base/common/platform';
import * as os from 'os';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { ConfigurationTarget, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import {
	ISerialLaunchConfig,
	ISerialMonitorService,
	ISerialPortInstance,
	ITerminalConfigHelper,
	ITerminalProcessExtHostProxy,
	NEVER_SUGGEST_SELECT_WINDOWS_SHELL_STORAGE_KEY,
	TERMINAL_PANEL_ID,
} from 'vs/workbench/parts/maix/serialPort/terminal/common/terminal';
import { TerminalService as AbstractTerminalService } from 'vs/workbench/parts/maix/serialPort/terminal/common/terminalService';
import { TerminalConfigHelper } from 'vs/workbench/parts/maix/serialPort/terminal/electron-browser/terminalConfigHelper';
import { TPromise } from 'vs/base/common/winjs.base';
import Severity from 'vs/base/common/severity';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { getTerminalDefaultShellWindows } from 'vs/workbench/parts/maix/serialPort/terminal/node/terminal';
import { TerminalPanel } from 'vs/workbench/parts/maix/serialPort/terminal/electron-browser/terminalPanel';
import { TerminalTab } from 'vs/workbench/parts/maix/serialPort/terminal/browser/terminalTab';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { ipcRenderer as ipc } from 'electron';
import { IOpenFileRequest } from 'vs/platform/windows/common/windows';
import { TerminalInstance } from 'vs/workbench/parts/maix/serialPort/terminal/electron-browser/terminalInstance';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { ISerialPortService } from 'vs/workbench/parts/maix/serialPort/node/serialPortService';
import { IPickOptions, IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';

export class TerminalService extends AbstractTerminalService implements ISerialMonitorService {
	private _configHelper: TerminalConfigHelper;
	public get configHelper(): ITerminalConfigHelper { return this._configHelper; }

	protected _terminalTabs: TerminalTab[];

	protected get _terminalInstances(): ISerialPortInstance[] {
		return this._terminalTabs.reduce((p, c) => p.concat(c.terminalInstances), <ISerialPortInstance[]>[]);
	}

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IPanelService panelService: IPanelService,
		@IPartService partService: IPartService,
		@IStorageService storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ISerialPortService private serialPortService: ISerialPortService,
	) {
		super(contextKeyService, panelService, partService, lifecycleService, storageService);

		this._terminalTabs = [];
		this._configHelper = this._instantiationService.createInstance(TerminalConfigHelper);

		ipc.on('vscode:openFiles', (_event: any, request: IOpenFileRequest) => {
			// if the request to open files is coming in from the integrated terminal (identified though
			// the termProgram variable) and we are instructed to wait for editors close, wait for the
			// marker file to get deleted and then focus back to the integrated terminal.
			if (request.termProgram === 'vscode' && request.filesToWait) {
				pfs.whenDeleted(request.filesToWait.waitMarkerFilePath).then(() => {
					if (this.terminalInstances.length > 0) {
						this.getActiveInstance().focus();
					}
				});
			}
		});
	}

	public createTerminal(shell: ISerialLaunchConfig = {}, wasNewTerminalAction?: boolean): ISerialPortInstance {
		const exists = this._terminalTabs.some((item) => {
			return item.id === shell.serialDevice;
		});
		if (exists) {
			throw new Error('device is already opened');
		}

		const terminalTab = this._instantiationService.createInstance(
			TerminalTab,
			this._terminalFocusContextKey,
			this._configHelper,
			this._terminalContainer,
			shell,
		);
		this._terminalTabs.push(terminalTab);
		const instance = terminalTab.terminalInstances[0];
		terminalTab.addDisposable(terminalTab.onDisposed(this._onTabDisposed.fire, this._onTabDisposed));
		terminalTab.addDisposable(terminalTab.onInstancesChanged(this._onInstancesChanged.fire, this._onInstancesChanged));
		this._initInstanceListeners(instance);
		if (this.terminalInstances.length === 1) {
			// It's the first instance so it should be made active automatically
			this.setActiveInstanceByIndex(0);
		}
		this._onInstancesChanged.fire();
		this._suggestShellChange(wasNewTerminalAction);
		return instance;
	}

	public createTerminalRenderer(name: string): ISerialPortInstance {
		return this.createTerminal({ name });
	}

	public createInstance(
		terminalFocusContextKey: IContextKey<boolean>,
		configHelper: ITerminalConfigHelper,
		container: HTMLElement,
		shellLaunchConfig: ISerialLaunchConfig,
		doCreateProcess: boolean,
	): ISerialPortInstance {
		const instance = this._instantiationService.createInstance(TerminalInstance, terminalFocusContextKey, configHelper, container, shellLaunchConfig);
		this._onInstanceCreated.fire(instance);
		return instance;
	}

	public requestExtHostProcess(proxy: ITerminalProcessExtHostProxy, shellLaunchConfig: ISerialLaunchConfig, cols: number, rows: number): void {
		// Ensure extension host is ready before requesting a process
		this._extensionService.whenInstalledExtensionsRegistered().then(() => {
			// TODO: MainThreadTerminalService is not ready at this point, fix this
			setTimeout(() => {
				this._onInstanceRequestExtHostProcess.fire({ proxy, shellLaunchConfig, cols, rows });
			}, 500);
		});
	}

	public focusFindWidget(): TPromise<void> {
		return this.showPanel(false).then(() => {
			const panel = this._panelService.getActivePanel() as TerminalPanel;
			panel.focusFindWidget();
			this._findWidgetVisible.set(true);
		});
	}

	public hideFindWidget(): void {
		const panel = this._panelService.getActivePanel() as TerminalPanel;
		if (panel && panel.getId() === TERMINAL_PANEL_ID) {
			panel.hideFindWidget();
			this._findWidgetVisible.reset();
			panel.focus();
		}
	}

	private _suggestShellChange(wasNewTerminalAction?: boolean): void {
		// Only suggest on Windows since $SHELL works great for macOS/Linux
		if (!platform.isWindows) {
			return;
		}

		// Only suggest when the terminal instance is being created by an explicit user action to
		// launch a terminal, as opposed to something like tasks, debug, panel restore, etc.
		if (!wasNewTerminalAction) {
			return;
		}

		// Don't suggest if the user has explicitly opted out
		const neverSuggest = this._storageService.getBoolean(NEVER_SUGGEST_SELECT_WINDOWS_SHELL_STORAGE_KEY, StorageScope.GLOBAL, false);
		if (neverSuggest) {
			return;
		}

		// Never suggest if the setting is non-default already (ie. they set the setting manually)
		if (this._configHelper.config.shell.windows !== getTerminalDefaultShellWindows()) {
			this._storageService.store(NEVER_SUGGEST_SELECT_WINDOWS_SHELL_STORAGE_KEY, true);
			return;
		}

		this._notificationService.prompt(
			Severity.Info,
			nls.localize('terminal.integrated.chooseWindowsShellInfo', 'You can change the default terminal shell by selecting the customize button.'),
			[
				{
					label: nls.localize('customize', 'Customize'),
					run: () => {
						this.selectDefaultWindowsShell().then(shell => {
							if (!shell) {
								return TPromise.as(null);
							}
							// Launch a new instance with the newly selected shell
							const instance = this.createTerminal({
								serialDevice: shell,
								options: {},
							});
							if (instance) {
								this.setActiveInstance(instance);
							}
							return TPromise.as(null);
						});
					},
				},
				{
					label: nls.localize('never again', 'Don\'t Show Again'),
					isSecondary: true,
					run: () => this._storageService.store(NEVER_SUGGEST_SELECT_WINDOWS_SHELL_STORAGE_KEY, true),
				},
			],
		);
	}

	public selectDefaultWindowsShell(): TPromise<string> {
		return this._detectWindowsShells().then(shells => {
			const options: IPickOptions<IQuickPickItem> = {
				placeHolder: nls.localize('terminal.integrated.chooseWindowsShell', 'Select your preferred terminal shell, you can change this later in your settings'),
			};
			return this._quickInputService.pick(shells, options).then(value => {
				if (!value) {
					return null;
				}
				const shell = value.description;
				return this._configurationService.updateValue('terminal.integrated.shell.windows', shell, ConfigurationTarget.USER).then(() => shell);
			});
		});
	}

	private _detectWindowsShells(): TPromise<IQuickPickItem[]> {
		// Determine the correct System32 path. We want to point to Sysnative
		// when the 32-bit version of VS Code is running on a 64-bit machine.
		// The reason for this is because PowerShell's important PSReadline
		// module doesn't work if this is not the case. See #27915.
		const is32ProcessOn64Windows = process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432');
		const system32Path = `${process.env['windir']}\\${is32ProcessOn64Windows ? 'Sysnative' : 'System32'}`;

		const osVersion = (/(\d+)\.(\d+)\.(\d+)/g).exec(os.release());
		let useWSLexe = false;

		if (osVersion && osVersion.length === 4) {
			const buildNumber = parseInt(osVersion[3]);
			if (buildNumber >= 16299) {
				useWSLexe = true;
			}
		}

		const expectedLocations = {
			'Command Prompt': [`${system32Path}\\cmd.exe`],
			PowerShell: [`${system32Path}\\WindowsPowerShell\\v1.0\\powershell.exe`],
			'WSL Bash': [`${system32Path}\\${useWSLexe ? 'wsl.exe' : 'bash.exe'}`],
			'Git Bash': [
				`${process.env['ProgramW6432']}\\Git\\bin\\bash.exe`,
				`${process.env['ProgramW6432']}\\Git\\usr\\bin\\bash.exe`,
				`${process.env['ProgramFiles']}\\Git\\bin\\bash.exe`,
				`${process.env['ProgramFiles']}\\Git\\usr\\bin\\bash.exe`,
				`${process.env['LocalAppData']}\\Programs\\Git\\bin\\bash.exe`,
			],
		};
		const promises: TPromise<[string, string]>[] = [];
		Object.keys(expectedLocations).forEach(key => promises.push(this._validateShellPaths(key, expectedLocations[key])));
		return TPromise.join(promises).then(results => {
			return results.filter(result => !!result).map(result => {
				return <IQuickPickItem>{
					label: result[0],
					description: result[1],
				};
			});
		});
	}

	private _validateShellPaths(label: string, potentialPaths: string[]): TPromise<[string, string]> {
		const current = potentialPaths.shift();
		return pfs.fileExists(current).then(exists => {
			if (!exists) {
				if (potentialPaths.length === 0) {
					return null;
				}
				return this._validateShellPaths(label, potentialPaths);
			}
			return [label, current] as [string, string];
		});
	}

	public getActiveOrCreateInstance(wasNewTerminalAction: true): TPromise<ISerialPortInstance>;
	public getActiveOrCreateInstance(): ISerialPortInstance;
	public getActiveOrCreateInstance(wasNewTerminalAction?: boolean): ISerialPortInstance | TPromise<ISerialPortInstance> {
		const activeInstance = this.getActiveInstance();
		if (!activeInstance && !wasNewTerminalAction) {
			return activeInstance;
		} else {
			return this.serialPortService.quickOpenDevice().then((dev) => {
				if (!dev) {
					return null;
				}

				const instance = this.createTerminal({
					name: dev,
					serialDevice: dev,
				}, true);

				if (!instance) {
					return null;
				}

				this.setActiveInstance(instance);

				return instance;
			});
		}
	}

	protected _showTerminalCloseConfirmation(): TPromise<boolean> {
		let message;
		if (this.terminalInstances.length === 1) {
			message = nls.localize('terminalService.terminalCloseConfirmationSingular', 'There is an active terminal session, do you want to kill it?');
		} else {
			message = nls.localize('terminalService.terminalCloseConfirmationPlural', 'There are {0} active terminal sessions, do you want to kill them?', this.terminalInstances.length);
		}

		return this._dialogService.confirm({
			message,
			type: 'warning',
		}).then(res => !res.confirmed);
	}

	public setContainers(panelContainer: HTMLElement, terminalContainer: HTMLElement): void {
		this._configHelper.panelContainer = panelContainer;
		this._terminalContainer = terminalContainer;
		this._terminalTabs.forEach(tab => tab.attachToElement(this._terminalContainer));
	}
}
