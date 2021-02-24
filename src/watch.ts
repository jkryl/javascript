import assert = require('assert');
import byline = require('byline');
import http = require('http');
import https = require('https');
import request = require('request');
import url = require('url');

import { Duplex } from 'stream';
import { KubeConfig } from './config';

export interface WatchUpdate {
    type: string;
    object: object;
}

// We cannot use the type ReadableStream because Request returned by request
// library is not a true ReadableStream and there is extra abort method.
export interface RequestResult {
    pipe(stream: Duplex): void;
    on(ev: string, cb: (arg: any) => void): void;
    abort(): void;
}

export interface Response {
    statusCode: number;
    statusMessage: string;
}

// The contract is that the provided request library will return a readable
// stream with abort method.
export interface RequestInterface {
    webRequest(opts: request.OptionsWithUri): RequestResult;
}

// We derive our own agent class for http/https. It is a workaround for a bug
// in the request lib where the keep-alive option isn't respected in all cases:
// https://github.com/request/request/issues/3367. The idea of the fix is to
// have an agent with unique name just for the watcher connections. The name
// is used by request library to construct pool-ID.
//
// TODO: Request lib is deprecated and cannot be fixed. It should be replaced
// by another library.
class HttpsWatcherAgent extends https.Agent {
    public name: string;

    constructor(opts: https.AgentOptions) {
        super(opts);
        // this is read and used by request lib when constructing the pool-id
        this.name = 'watcherHttpsAgent';
    }
}
class HttpWatcherAgent extends http.Agent {
    public name: string;

    constructor(opts: http.AgentOptions) {
        super(opts);
        this.name = 'watcherHttpAgent';
    }
}

export class DefaultRequest implements RequestInterface {
    // requestImpl can be overriden in case we need to test mocked DefaultRequest
    private requestImpl: (opts: request.OptionsWithUri) => request.Request;

    constructor(requestImpl?: (opts: request.OptionsWithUri) => request.Request) {
        this.requestImpl = requestImpl ? requestImpl : request;
    }

    // Using request lib can be confusing when combining Stream- with Callback-
    // style API. We avoid the callback and handle HTTP response errors, that
    // would otherwise require a different error handling, in a transparent way
    // to the user (see github issue request/request#647 for more info).
    public webRequest(opts: request.OptionsWithUri): RequestResult {
        // agentClass is set here in webRequest hook because it is a workaround
        // specific to the request lib. Other HTTP libraries don't need it.
        if (opts.agentClass === undefined) {
            let proto: string;
            if (typeof opts.uri === 'string') {
                proto = url.parse(opts.uri).protocol || 'http';
            } else {
                proto = opts.uri.protocol || 'http';
            }
            let agentClass;
            if (proto === 'https:') {
                agentClass = HttpsWatcherAgent;
            } else if (proto === 'http:') {
                agentClass = HttpWatcherAgent;
            } else {
                assert(false, `Unknown protocol "${proto}"`);
            }
            opts.agentClass = agentClass;
        }
        const req = this.requestImpl(opts);
        // pause the stream until we get a response not to miss any bytes
        req.pause();
        req.on('response', (resp) => {
            if (resp.statusCode === 200) {
                req.resume();
            } else {
                req.emit('error', new Error(resp.statusMessage));
            }
        });
        return req;
    }
}

export class Watch {
    public static SERVER_SIDE_CLOSE: object = { error: 'Connection closed on server' };
    public config: KubeConfig;
    private readonly requestImpl: RequestInterface;

    public constructor(config: KubeConfig, requestImpl?: RequestInterface) {
        this.config = config;
        if (requestImpl) {
            this.requestImpl = requestImpl;
        } else {
            this.requestImpl = new DefaultRequest();
        }
    }

    // Watch the resource and call provided callback with parsed json object
    // upon event received over the watcher connection.
    //
    // "done" callback is called either when connection is closed or when there
    // is an error. In either case, watcher takes care of properly closing the
    // underlaying connection so that it doesn't leak any resources.
    public async watch(
        path: string,
        queryParams: any,
        callback: (phase: string, apiObj: any, watchObj?: any) => void,
        done: (err: any) => void,
    ): Promise<any> {
        const cluster = this.config.getCurrentCluster();
        if (!cluster) {
            throw new Error('No currently active cluster');
        }
        const uri = cluster.server + path;

        queryParams.watch = true;
        const headerParams: any = {};

        const requestOptions: request.OptionsWithUri = {
            method: 'GET',
            qs: queryParams,
            headers: headerParams,
            uri,
            useQuerystring: true,
            json: true,
            agentOptions: {
                keepAlive: true,
            },
        };
        await this.config.applyToRequest(requestOptions);

        let req;
        let doneCalled: boolean = false;
        const doneCallOnce = (err: any) => {
            if (!doneCalled) {
                req.abort();
                doneCalled = true;
                done(err);
            }
        };
        req = this.requestImpl.webRequest(requestOptions);
        const stream = byline.createStream();
        req.on('error', doneCallOnce);
        stream.on('error', doneCallOnce);
        stream.on('close', () => doneCallOnce(null));
        stream.on('data', (line) => {
            try {
                const data = JSON.parse(line);
                callback(data.type, data.object, data);
            } catch (ignore) {
                // ignore parse errors
            }
        });

        req.pipe(stream);
        return req;
    }
}
