/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as jsonc from 'jsonc-parser';

import { request } from '../spec-utils/httpRequest';
import * as crypto from 'crypto';
import { Log, LogLevel } from '../spec-utils/log';

export interface DisallowedFeature {
	featureIdPrefix: string;
	documentationURL?: string;
}

export interface DevContainerControlManifest {
	disallowedFeatures: DisallowedFeature[];
}

const controlManifestPath = path.join(os.homedir(), '.devcontainer', 'cache', 'control-manifest.json');

const emptyControlManifest: DevContainerControlManifest = {
	disallowedFeatures: [],
};

const cacheTimeoutMillis = 5 * 60 * 1000; // 5 minutes

export async function getControlManifest(output: Log): Promise<DevContainerControlManifest> {
	const cacheStat = await fs.stat(controlManifestPath)
		.catch(err => {
			if (err?.code !== 'ENOENT') {
				throw err;
			}
		});
	const cacheBuffer = cacheStat?.isFile() ? await fs.readFile(controlManifestPath)
		.catch(err => {
			if (err?.code !== 'ENOENT') {
				throw err;
			}
		}) : undefined;
	const cachedManifest = cacheBuffer ? sanitizeControlManifest(jsonc.parse(cacheBuffer.toString())) : undefined;
	if (cacheStat && cachedManifest && cacheStat.mtimeMs + cacheTimeoutMillis > Date.now()) {
		return cachedManifest;
	}
	return updateControlManifest(cachedManifest, output);
}

async function updateControlManifest(oldManifest: DevContainerControlManifest | undefined, output: Log): Promise<DevContainerControlManifest> {
	let manifestBuffer: Buffer;
	try {
		manifestBuffer = await fetchControlManifest();
	} catch (error) {
		output.write(`Failed to fetch control manifest: ${error.message}`, LogLevel.Error);
		if (oldManifest) {
			// Keep old manifest to not lose existing information and update timestamp to avoid flooding the server.
			const now = new Date();
			await fs.utimes(controlManifestPath, now, now);
			return oldManifest;
		}
		manifestBuffer = Buffer.from(JSON.stringify(emptyControlManifest, undefined, 2));
	}

	const controlManifestTmpPath = `${controlManifestPath}-${crypto.randomUUID()}`;
	await fs.mkdir(path.dirname(controlManifestPath), { recursive: true });
	await fs.writeFile(controlManifestTmpPath, manifestBuffer);
	await fs.rename(controlManifestTmpPath, controlManifestPath);
	return sanitizeControlManifest(jsonc.parse(manifestBuffer.toString()));
}

async function fetchControlManifest() {
	return request({
		type: 'GET',
		url: 'https://containers.dev/static/devcontainer-control-manifest.json',
		headers: {
			'user-agent': 'devcontainers-vscode',
			'accept': 'application/json',
		},
	});
}

function sanitizeControlManifest(manifest: any): DevContainerControlManifest {
	if (!manifest || typeof manifest !== 'object') {
		return emptyControlManifest;
	}
	const disallowedFeatures = manifest.disallowedFeatures as DisallowedFeature[] | undefined;
	return {
		disallowedFeatures: Array.isArray(disallowedFeatures) ? disallowedFeatures.filter(f => typeof f.featureIdPrefix === 'string') : [],
	};
}
