import { Action } from 'vs/base/common/actions';
import { TPromise } from 'vs/base/common/winjs.base';
import { localize } from 'vs/nls';
import { ACTION_ID_MAIX_CMAKE_RUN, ICMakeService } from 'vs/workbench/parts/maix/cmake/common/type';
import { MaixCMakeCleanupAction } from 'vs/workbench/parts/maix/cmake/electron-browser/actions/cleanupAction';
import { ICompound, IDebugService, ILaunch } from 'vs/workbench/parts/debug/common/debug';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IWorkspaceContextService, IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import uri from 'vs/base/common/uri';
import { IEditor } from 'vs/workbench/common/editor';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { resolvePath } from 'vs/workbench/parts/maix/_library/node/resolvePath';
import { INodePathService, MAIX_CONFIG_KEY_DEBUG } from 'vs/workbench/parts/maix/_library/common/type';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ILogService } from 'vs/platform/log/common/log';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { executableExtension } from 'vs/workbench/parts/maix/_library/node/versions';
import { getEnvironment, unsetEnvironment } from 'vs/workbench/parts/maix/_library/common/path';
import { ShellExportCommand } from 'vs/workbench/parts/maix/_library/common/platformEnv';
import { writeFile } from 'vs/base/node/pfs';
import { isWindows } from 'vs/base/common/platform';

class WorkspaceMaixLaunch implements ILaunch {
	protected GDB: string;

	protected PYTHON: string;

	constructor(
		protected programFile: string,
		@IEditorService protected editorService: IEditorService,
		@IWorkspaceContextService protected contextService: IWorkspaceContextService,
		@INodePathService protected nodePathService: INodePathService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IConfigurationService protected configurationService: IConfigurationService,
		@IWorkspaceContextService protected workspaceContextService: IWorkspaceContextService,
	) {
		this.GDB = resolvePath(nodePathService.getToolchainBinPath(), 'riscv64-unknown-elf-gdb' + executableExtension);
		// this.PYTHON = resolvePath(nodePathService.getToolchainPath(), 'share/gdb/python/gdb');
		// this.PYTHON += isWindows ? ';' : ':';
		this.PYTHON = nodePathService.getPackagesPath('py2lib');
	}

	public get workspace(): IWorkspaceFolder {
		return this.workspaceContextService.getWorkspace().folders[0];
	}

	public get uri(): uri {
		return this.contextService.getWorkspace().configuration;
	}

	public get name(): string {
		return localize('workspace', 'workspace');
	}

	public get hidden(): boolean {
		return true;
	}

	public getCompound(name: string): ICompound {
		return null;
	}

	public getConfigurationNames(includeCompounds = true): string[] {
		return ['default'];
	}

	public getConfiguration() {
		const target = this.configurationService.getValue(MAIX_CONFIG_KEY_DEBUG);
		return {
			type: 'gdb',
			request: 'attach',
			name: 'debug maix project',
			executable: this.programFile,
			target: target || '127.0.0.1:3333', // <<== TODO
			remote: true,
			cwd: '${workspaceRoot}/build',
			internalConsoleOptions: 'openOnSessionStart' as any,
			env: {
				...unsetEnvironment(),
				...getEnvironment(this.nodePathService),
				PYTHONPATH: this.PYTHON,
				PYTHONHOME: this.PYTHON,
			},
			printCalls: true,
			stopOnEntry: false,
			showDevDebugOutput: true,
			autorun: [
				`python for cmd in ['delete breakpoints', 'delete tracepoints', 'load', 'interrupt']: gdb.execute(cmd)`,
			],
			gdbpath: this.GDB,
		};
	}

	openConfigFile(sideBySide: boolean, preserveFocus: boolean, type?: string): TPromise<{ editor: IEditor, created: boolean }> {
		return this.editorService.openEditor({
			resource: this.contextService.getWorkspace().folders[0].toResource('.vscode/maix.json'),
		}).then(editor => ({ editor, created: false }));
	}
}

export class MaixCMakeDebugAction extends Action {
	public static readonly ID = ACTION_ID_MAIX_CMAKE_RUN;
	public static readonly LABEL = localize('Debug', 'Debug');

	constructor(
		id = MaixCMakeCleanupAction.ID, label = MaixCMakeCleanupAction.LABEL,
		@ICMakeService private cmakeService: ICMakeService,
		@IDebugService private debugService: IDebugService,
		@ILogService private logService: ILogService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@INotificationService private notificationService: INotificationService,
	) {
		super(MaixCMakeDebugAction.ID, MaixCMakeDebugAction.LABEL);
	}

	async run(): TPromise<void> {
		const file = await this.cmakeService.getOutputFile();
		const launch = this.instantiationService.createInstance(WorkspaceMaixLaunch, file);
		const config = launch.getConfiguration();

		this.logService.info('Debug Config:', config);
		const buildDir = config.env.PWD || resolvePath(launch.workspace.uri.fsPath, 'build');
		let dbg = `cd "${buildDir}"\n`;
		for (const k of Object.keys(config.env)) {
			if (config.env[k]) {
				dbg += ShellExportCommand + ' ' + k + '=' + config.env[k] + '\n';
			}
		}
		dbg += '"' + config.gdbpath + '" ' + `--eval "target remote ${config.target}"` + ' "' + config.executable + '"';
		writeFile(resolvePath(launch.workspace.uri.fsPath, '.vscode', isWindows ? 'debugger.bat' : 'debugger.sh'), dbg);

		await this.debugService.startDebugging(launch, config).then(undefined, (e) => {
			debugger;
			this.notificationService.error('Failed to start debug:\n' + e.message);
			throw e;
		});
	}
}
