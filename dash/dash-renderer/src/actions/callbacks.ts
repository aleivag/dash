import {
    concat,
    flatten,
    intersection,
    keys,
    map,
    mergeDeepRight,
    path,
    pick,
    pluck,
    values,
    toPairs,
    zip,
    assocPath
} from 'ramda';

import {STATUS, JWT_EXPIRED_MESSAGE} from '../constants/constants';
import {MAX_AUTH_RETRIES} from './constants';
import {
    CallbackActionType,
    CallbackAggregateActionType
} from '../reducers/callbacks';
import {
    CallbackResult,
    ICallback,
    IExecutedCallback,
    IExecutingCallback,
    ICallbackPayload,
    IStoredCallback,
    IBlockedCallback,
    IPrioritizedCallback,
    LongCallbackInfo,
    CallbackResponse,
    CallbackResponseData
} from '../types/callbacks';
import {isMultiValued, stringifyId, isMultiOutputProp} from './dependencies';
import {urlBase} from './utils';
import {getCSRFHeader} from '.';
import {createAction, Action} from 'redux-actions';
import {addHttpHeaders} from '../actions';
import {notifyObservers, updateProps} from './index';
import {CallbackJobPayload} from '../reducers/callbackJobs';
import {handlePatch} from './patch';
import {getPath} from './paths';

export const addBlockedCallbacks = createAction<IBlockedCallback[]>(
    CallbackActionType.AddBlocked
);
export const addCompletedCallbacks = createAction<number>(
    CallbackAggregateActionType.AddCompleted
);
export const addExecutedCallbacks = createAction<IExecutedCallback[]>(
    CallbackActionType.AddExecuted
);
export const addExecutingCallbacks = createAction<IExecutingCallback[]>(
    CallbackActionType.AddExecuting
);
export const addPrioritizedCallbacks = createAction<ICallback[]>(
    CallbackActionType.AddPrioritized
);
export const addRequestedCallbacks = createAction<ICallback[]>(
    CallbackActionType.AddRequested
);
export const addStoredCallbacks = createAction<IStoredCallback[]>(
    CallbackActionType.AddStored
);
export const addWatchedCallbacks = createAction<IExecutingCallback[]>(
    CallbackActionType.AddWatched
);
export const removeExecutedCallbacks = createAction(
    CallbackActionType.RemoveExecuted
);
export const removeBlockedCallbacks = createAction<IBlockedCallback[]>(
    CallbackActionType.RemoveBlocked
);
export const removeExecutingCallbacks = createAction<IExecutingCallback[]>(
    CallbackActionType.RemoveExecuting
);
export const removePrioritizedCallbacks = createAction<ICallback[]>(
    CallbackActionType.RemovePrioritized
);
export const removeRequestedCallbacks = createAction<ICallback[]>(
    CallbackActionType.RemoveRequested
);
export const removeStoredCallbacks = createAction<IStoredCallback[]>(
    CallbackActionType.RemoveStored
);
export const removeWatchedCallbacks = createAction<IExecutingCallback[]>(
    CallbackActionType.RemoveWatched
);
export const aggregateCallbacks = createAction<
    (Action<ICallback[]> | Action<number> | null)[]
>(CallbackAggregateActionType.Aggregate);

const updateResourceUsage = createAction('UPDATE_RESOURCE_USAGE');

const addCallbackJob = createAction('ADD_CALLBACK_JOB');
const removeCallbackJob = createAction('REMOVE_CALLBACK_JOB');
const setCallbackJobOutdated = createAction('CALLBACK_JOB_OUTDATED');

function unwrapIfNotMulti(
    paths: any,
    idProps: any,
    spec: any,
    anyVals: any,
    depType: any
) {
    let msg = '';

    if (isMultiValued(spec)) {
        return [idProps, msg];
    }

    if (idProps.length !== 1) {
        if (!idProps.length) {
            const isStr = typeof spec.id === 'string';
            msg =
                'A nonexistent object was used in an `' +
                depType +
                '` of a Dash callback. The id of this object is ' +
                (isStr
                    ? '`' + spec.id + '`'
                    : JSON.stringify(spec.id) +
                      (anyVals ? ' with MATCH values ' + anyVals : '')) +
                ' and the property is `' +
                spec.property +
                (isStr
                    ? '`. The string ids in the current layout are: [' +
                      keys(paths.strs).join(', ') +
                      ']'
                    : '`. The wildcard ids currently available are logged above.');
        } else {
            msg =
                'Multiple objects were found for an `' +
                depType +
                '` of a callback that only takes one value. The id spec is ' +
                JSON.stringify(spec.id) +
                (anyVals ? ' with MATCH values ' + anyVals : '') +
                ' and the property is `' +
                spec.property +
                '`. The objects we found are: ' +
                JSON.stringify(map(pick(['id', 'property']), idProps));
        }
    }
    return [idProps[0], msg];
}

function fillVals(
    paths: any,
    layout: any,
    cb: ICallback,
    specs: any,
    depType: any,
    allowAllMissing = false
) {
    const getter = depType === 'Input' ? cb.getInputs : cb.getState;
    const errors: any[] = [];
    let emptyMultiValues = 0;

    const inputVals = getter(paths).map((inputList: any, i: number) => {
        const [inputs, inputError] = unwrapIfNotMulti(
            paths,
            inputList.map(({id, property, path: path_}: any) => ({
                id,
                property,
                value: (path(path_, layout) as any).props[property]
            })),
            specs[i],
            cb.anyVals,
            depType
        );
        if (isMultiValued(specs[i]) && !inputs.length) {
            emptyMultiValues++;
        }
        if (inputError) {
            errors.push(inputError);
        }
        return inputs;
    });

    if (errors.length) {
        if (
            allowAllMissing &&
            errors.length + emptyMultiValues === inputVals.length
        ) {
            // We have at least one non-multivalued input, but all simple and
            // multi-valued inputs are missing.
            // (if all inputs are multivalued and all missing we still return
            // them as normal, and fire the callback.)
            return null;
        }
        // If we get here we have some missing and some present inputs.
        // Or all missing in a context that doesn't allow this.
        // That's a real problem, so throw the first message as an error.
        refErr(errors, paths);
    }

    return inputVals;
}

function refErr(errors: any, paths: any) {
    const err = errors[0];
    if (err.indexOf('logged above') !== -1) {
        // Wildcard reference errors mention a list of wildcard specs logged
        // TODO: unwrapped list of wildcard ids?
        // eslint-disable-next-line no-console
        console.error(paths.objs);
    }
    throw new ReferenceError(err);
}

const getVals = (input: any) =>
    Array.isArray(input) ? pluck('value', input) : input.value;

const zipIfArray = (a: any, b: any) =>
    Array.isArray(a) ? zip(a, b) : [[a, b]];

async function handleClientside(
    dispatch: any,
    clientside_function: any,
    config: any,
    payload: ICallbackPayload
) {
    const dc = ((window as any).dash_clientside =
        (window as any).dash_clientside || {});
    if (!dc.no_update) {
        Object.defineProperty(dc, 'no_update', {
            value: {description: 'Return to prevent updating an Output.'},
            writable: false
        });

        Object.defineProperty(dc, 'PreventUpdate', {
            value: {description: 'Throw to prevent updating all Outputs.'},
            writable: false
        });
    }

    const {inputs, outputs, state} = payload;
    const requestTime = Date.now();

    const inputDict = inputsToDict(inputs);
    const stateDict = inputsToDict(state);
    const result: any = {};
    let status: any = STATUS.OK;

    try {
        const {namespace, function_name} = clientside_function;
        let args = inputs.map(getVals);
        if (state) {
            args = concat(args, state.map(getVals));
        }

        // setup callback context
        dc.callback_context = {};
        dc.callback_context.triggered = payload.changedPropIds.map(prop_id => ({
            prop_id: prop_id,
            value: inputDict[prop_id]
        }));
        dc.callback_context.inputs_list = inputs;
        dc.callback_context.inputs = inputDict;
        dc.callback_context.states_list = state;
        dc.callback_context.states = stateDict;

        let returnValue = dc[namespace][function_name](...args);

        delete dc.callback_context;

        if (typeof returnValue?.then === 'function') {
            returnValue = await returnValue;
        }

        zipIfArray(outputs, returnValue).forEach(([outi, reti]) => {
            zipIfArray(outi, reti).forEach(([outij, retij]) => {
                const {id, property} = outij;
                const idStr = stringifyId(id);
                const dataForId = (result[idStr] = result[idStr] || {});
                if (retij !== dc.no_update) {
                    dataForId[property] = retij;
                }
            });
        });
    } catch (e) {
        if (e === dc.PreventUpdate) {
            status = STATUS.PREVENT_UPDATE;
        } else {
            status = STATUS.CLIENTSIDE_ERROR;
            throw e;
        }
    } finally {
        delete dc.callback_context;

        // Setting server = client forces network = 0
        const totalTime = Date.now() - requestTime;
        const resources = {
            __dash_server: totalTime,
            __dash_client: totalTime,
            __dash_upload: 0,
            __dash_download: 0
        };

        if (config.ui) {
            dispatch(
                updateResourceUsage({
                    id: payload.output,
                    usage: resources,
                    status,
                    result,
                    inputs,
                    state
                })
            );
        }
    }

    return result;
}

function sideUpdate(outputs: any, dispatch: any, paths: any) {
    toPairs(outputs).forEach(([id, value]) => {
        const [componentId, propName] = id.split('.');
        const componentPath = paths.strs[componentId];
        dispatch(
            updateProps({
                props: {[propName]: value},
                itempath: componentPath
            })
        );
        dispatch(
            notifyObservers({id: componentId, props: {[propName]: value}})
        );
    });
}

function handleServerside(
    dispatch: any,
    hooks: any,
    config: any,
    payload: any,
    paths: any,
    long: LongCallbackInfo | undefined,
    additionalArgs: [string, string, boolean?][] | undefined,
    getState: any,
    output: string
): Promise<CallbackResponse> {
    if (hooks.request_pre) {
        hooks.request_pre(payload);
    }

    const requestTime = Date.now();
    const body = JSON.stringify(payload);
    let cacheKey: string;
    let job: string;
    let runningOff: any;
    let progressDefault: any;
    let moreArgs = additionalArgs;

    const fetchCallback = () => {
        const headers = getCSRFHeader() as any;
        let url = `${urlBase(config)}_dash-update-component`;

        const addArg = (name: string, value: string) => {
            let delim = '?';
            if (url.includes('?')) {
                delim = '&';
            }
            url = `${url}${delim}${name}=${value}`;
        };
        if (cacheKey) {
            addArg('cacheKey', cacheKey);
        }
        if (job) {
            addArg('job', job);
        }

        if (moreArgs) {
            moreArgs.forEach(([key, value]) => addArg(key, value));
            moreArgs = moreArgs.filter(([_, __, single]) => !single);
        }

        return fetch(
            url,
            mergeDeepRight(config.fetch, {
                method: 'POST',
                headers,
                body
            })
        );
    };

    return new Promise((resolve, reject) => {
        const handleOutput = (res: any) => {
            const {status} = res;

            if (job) {
                const callbackJob = getState().callbackJobs[job];
                if (callbackJob?.outdated) {
                    dispatch(removeCallbackJob({jobId: job}));
                    return resolve({});
                }
            }

            function recordProfile(result: any) {
                if (config.ui) {
                    // Callback profiling - only relevant if we're showing the debug ui
                    const resources = {
                        __dash_server: 0,
                        __dash_client: Date.now() - requestTime,
                        __dash_upload: body.length,
                        __dash_download: Number(
                            res.headers.get('Content-Length')
                        )
                    } as any;

                    const timingHeaders =
                        res.headers.get('Server-Timing') || '';

                    timingHeaders.split(',').forEach((header: any) => {
                        const name = header.split(';')[0];
                        const dur = header.match(/;dur=[0-9.]+/);

                        if (dur) {
                            resources[name] = Number(dur[0].slice(5));
                        }
                    });

                    dispatch(
                        updateResourceUsage({
                            id: payload.output,
                            usage: resources,
                            status,
                            result,
                            inputs: payload.inputs,
                            state: payload.state
                        })
                    );
                }
            }

            const finishLine = (data: CallbackResponseData) => {
                const {multi, response} = data;
                if (hooks.request_post) {
                    hooks.request_post(payload, response);
                }

                let result;
                if (multi) {
                    result = response as CallbackResponse;
                } else {
                    const {output} = payload;
                    const id = output.substr(0, output.lastIndexOf('.'));
                    result = {[id]: (response as CallbackResponse).props};
                }

                recordProfile(result);
                resolve(result);
            };

            const completeJob = () => {
                if (job) {
                    dispatch(removeCallbackJob({jobId: job}));
                }
                if (runningOff) {
                    sideUpdate(runningOff, dispatch, paths);
                }
                if (progressDefault) {
                    sideUpdate(progressDefault, dispatch, paths);
                }
            };

            if (status === STATUS.OK) {
                res.json().then((data: CallbackResponseData) => {
                    if (!cacheKey && data.cacheKey) {
                        cacheKey = data.cacheKey;
                    }

                    if (!job && data.job) {
                        const jobInfo: CallbackJobPayload = {
                            jobId: data.job,
                            cacheKey: data.cacheKey as string,
                            cancelInputs: data.cancel,
                            progressDefault: data.progressDefault,
                            output
                        };
                        dispatch(addCallbackJob(jobInfo));
                        job = data.job;
                    }

                    if (data.progress) {
                        sideUpdate(data.progress, dispatch, paths);
                    }
                    if (data.running) {
                        sideUpdate(data.running, dispatch, paths);
                    }
                    if (!runningOff && data.runningOff) {
                        runningOff = data.runningOff;
                    }
                    if (!progressDefault && data.progressDefault) {
                        progressDefault = data.progressDefault;
                    }

                    if (!long || data.response !== undefined) {
                        completeJob();
                        finishLine(data);
                    } else {
                        // Poll chain.
                        setTimeout(
                            handle,
                            long.interval !== undefined ? long.interval : 500
                        );
                    }
                });
            } else if (status === STATUS.PREVENT_UPDATE) {
                completeJob();
                recordProfile({});
                resolve({});
            } else {
                completeJob();
                reject(res);
            }
        };

        const handleError = () => {
            if (config.ui) {
                dispatch(
                    updateResourceUsage({
                        id: payload.output,
                        status: STATUS.NO_RESPONSE,
                        result: {},
                        inputs: payload.inputs,
                        state: payload.state
                    })
                );
            }
            reject(new Error('Callback failed: the server did not respond.'));
        };

        const handle = () => {
            fetchCallback().then(handleOutput, handleError);
        };
        handle();
    });
}

function inputsToDict(inputs_list: any) {
    // Ported directly from _utils.py, inputs_to_dict
    // takes an array of inputs (some inputs may be an array)
    // returns an Object (map):
    //  keys of the form `id.property` or `{"id": 0}.property`
    //  values contain the property value
    if (!inputs_list) {
        return {};
    }
    const inputs: any = {};
    for (let i = 0; i < inputs_list.length; i++) {
        if (Array.isArray(inputs_list[i])) {
            const inputsi = inputs_list[i];
            for (let ii = 0; ii < inputsi.length; ii++) {
                const id_str = `${stringifyId(inputsi[ii].id)}.${
                    inputsi[ii].property
                }`;
                inputs[id_str] = inputsi[ii].value ?? null;
            }
        } else {
            const id_str = `${stringifyId(inputs_list[i].id)}.${
                inputs_list[i].property
            }`;
            inputs[id_str] = inputs_list[i].value ?? null;
        }
    }
    return inputs;
}

export function executeCallback(
    cb: IPrioritizedCallback,
    config: any,
    hooks: any,
    paths: any,
    layout: any,
    {allOutputs}: any,
    dispatch: any,
    getState: any
): IExecutingCallback {
    const {output, inputs, state, clientside_function, long} = cb.callback;
    try {
        const inVals = fillVals(paths, layout, cb, inputs, 'Input', true);

        /* Prevent callback if there's no inputs */
        if (inVals === null) {
            return {
                ...cb,
                executionPromise: null
            };
        }

        const outputs: any[] = [];
        const outputErrors: any[] = [];
        allOutputs.forEach((out: any, i: number) => {
            const [outi, erri] = unwrapIfNotMulti(
                paths,
                map(pick(['id', 'property']), out),
                cb.callback.outputs[i],
                cb.anyVals,
                'Output'
            );
            outputs.push(outi);
            if (erri) {
                outputErrors.push(erri);
            }
        });

        if (outputErrors.length) {
            if (flatten(inVals).length) {
                refErr(outputErrors, paths);
            }
            // This case is all-empty multivalued wildcard inputs,
            // which we would normally fire the callback for, except
            // some outputs are missing. So instead we treat it like
            // regular missing inputs and just silently prevent it.
            return {
                ...cb,
                executionPromise: null
            };
        }

        const __execute = async (): Promise<CallbackResult> => {
            try {
                const payload: ICallbackPayload = {
                    output,
                    outputs: isMultiOutputProp(output) ? outputs : outputs[0],
                    inputs: inVals,
                    changedPropIds: keys(cb.changedPropIds),
                    state: cb.callback.state.length
                        ? fillVals(paths, layout, cb, state, 'State')
                        : undefined
                };

                if (clientside_function) {
                    try {
                        const data = await handleClientside(
                            dispatch,
                            clientside_function,
                            config,
                            payload
                        );
                        return {data, payload};
                    } catch (error: any) {
                        return {error, payload};
                    }
                }

                let newConfig = config;
                let newHeaders: Record<string, string> | null = null;
                let lastError: any;

                const additionalArgs: [string, string, boolean?][] = [];
                values(getState().callbackJobs).forEach(
                    (job: CallbackJobPayload) => {
                        if (cb.callback.output === job.output) {
                            // Terminate the old jobs that are not completed
                            // set as outdated for the callback promise to
                            // resolve and remove after.
                            additionalArgs.push(['oldJob', job.jobId, true]);
                            dispatch(
                                setCallbackJobOutdated({jobId: job.jobId})
                            );
                        }
                        if (!job.cancelInputs) {
                            return;
                        }
                        const inter = intersection(
                            job.cancelInputs,
                            cb.callback.inputs
                        );
                        if (inter.length) {
                            additionalArgs.push(['cancelJob', job.jobId]);
                            if (job.progressDefault) {
                                sideUpdate(
                                    job.progressDefault,
                                    dispatch,
                                    paths
                                );
                            }
                        }
                    }
                );

                for (let retry = 0; retry <= MAX_AUTH_RETRIES; retry++) {
                    try {
                        let data = await handleServerside(
                            dispatch,
                            hooks,
                            newConfig,
                            payload,
                            paths,
                            long,
                            additionalArgs.length ? additionalArgs : undefined,
                            getState,
                            cb.callback.output
                        );

                        if (newHeaders) {
                            dispatch(addHttpHeaders(newHeaders));
                        }

                        outputs.forEach((out: any) => {
                            const propName = out.property.split('@')[0];
                            const outputPath = getPath(paths, out.id);
                            const previousValue = path(
                                outputPath.concat(['props', propName]),
                                layout
                            );
                            const dataPath = [out.id, propName];
                            data = assocPath(
                                dataPath,
                                handlePatch(
                                    previousValue,
                                    path(dataPath, data)
                                ),
                                data
                            );
                        });

                        return {data, payload};
                    } catch (res: any) {
                        lastError = res;
                        if (
                            retry <= MAX_AUTH_RETRIES &&
                            (res.status === STATUS.UNAUTHORIZED ||
                                res.status === STATUS.BAD_REQUEST)
                        ) {
                            const body = await res.text();

                            if (body.includes(JWT_EXPIRED_MESSAGE)) {
                                if (hooks.request_refresh_jwt !== null) {
                                    let oldJwt = null;
                                    if (config.fetch.headers.Authorization) {
                                        oldJwt =
                                            config.fetch.headers.Authorization.substr(
                                                'Bearer '.length
                                            );
                                    }

                                    const newJwt =
                                        await hooks.request_refresh_jwt(oldJwt);
                                    if (newJwt) {
                                        newHeaders = {
                                            Authorization: `Bearer ${newJwt}`
                                        };

                                        newConfig = mergeDeepRight(config, {
                                            fetch: {
                                                headers: newHeaders
                                            }
                                        });

                                        continue;
                                    }
                                }
                            }
                        }

                        break;
                    }
                }

                // we reach here when we run out of retries.
                return {error: lastError, payload: null};
            } catch (error: any) {
                return {error, payload: null};
            }
        };

        const newCb = {
            ...cb,
            executionPromise: __execute()
        };

        return newCb;
    } catch (error: any) {
        return {
            ...cb,
            executionPromise: {error, payload: null}
        };
    }
}
