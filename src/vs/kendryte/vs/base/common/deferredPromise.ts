import { canceled } from 'vs/base/common/errors';

export type ValueCallback<T = any> = (value: T | Thenable<T>) => void;
export type ProgressCallback<T = any> = (value: T) => void;

export interface IProgressHolder<T, PT> {
	progress(fn: ProgressCallback<PT>): Promise<T> & IProgressHolder<T, PT>;
}

export class DeferredPromise<T, PT = any> {
	public p: Promise<T> & IProgressHolder<T, PT>;
	private completeCallback: ValueCallback<T>;
	private errorCallback: (err: any) => void;
	private _state: boolean | null = null;
	private cbList: ProgressCallback<PT>[] = [];

	constructor() {
		this.p = Object.assign(new Promise<any>((c, e) => {
			this.completeCallback = c;
			this.errorCallback = e;
		}), {
			progress: (fn: ProgressCallback<PT>) => {
				this.progress(fn);
				return this.p;
			},
		});
		this.p.finally(() => {
			delete this.cbList;
		});
	}

	notify(progress: PT): this {
		for (const cb of this.cbList) {
			cb(progress);
		}
		return this;
	}

	progress(fn: ProgressCallback<PT>): void {
		this.cbList.push(fn);
	}

	get completed() {
		return typeof this._state === 'boolean';
	}

	get resolved() {
		return this._state === true;
	}

	get rejected() {
		return this._state === false;
	}

	public complete(value: T) {
		this._state = true;
		this.completeCallback(value);
	}

	public error(err: any) {
		this._state = false;
		this.errorCallback(err);
	}

	public cancel() {
		this._state = false;
		this.errorCallback(canceled());
	}
}
