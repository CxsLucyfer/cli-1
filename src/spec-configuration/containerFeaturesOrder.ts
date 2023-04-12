/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { FeatureSet, userFeaturesToArray } from '../spec-configuration/containerFeaturesConfiguration';
import { LogLevel } from '../spec-utils/log';
import { DevContainerConfig } from './configuration';
import { OCIRef, getRef } from './containerCollectionsOCI';
import { CommonParams } from './containerCollectionsOCI';
import { fetchOCIFeatureManifestIfExistsFromUserIdentifier } from './containerFeaturesOCI';

interface FeatureNode {
    feature: FeatureSet;
    before: Set<FeatureNode>;
    after: Set<FeatureNode>;
}

export function computeFeatureInstallationOrder(config: DevContainerConfig, features: FeatureSet[]) {

    if (config.overrideFeatureInstallOrder) {
        return computeOverrideInstallationOrder(config, features);
    }
    else {
        return computeInstallationOrder(features);
    }
}

// Exported for unit tests.
export function computeOverrideInstallationOrder(config: DevContainerConfig, features: FeatureSet[]) {
    // Starts with the automatic installation order.
    const automaticOrder = computeInstallationOrder(features);

    // Moves to the beginning the features that are explicitly configured.
    const orderedFeatures = [];
    for (const featureId of config.overrideFeatureInstallOrder!) {
        // Reference: https://github.com/devcontainers/spec/blob/main/proposals/devcontainer-features.md#1-overridefeatureinstallorder
        const feature = automaticOrder.find(feature => feature.sourceInformation.userFeatureIdWithoutVersion === featureId || feature.sourceInformation.userFeatureId === featureId);
        if (!feature) {
            throw new Error(`Feature ${featureId} not found`);
        }
        orderedFeatures.push(feature);
        features.splice(features.indexOf(feature), 1);
    }

    return orderedFeatures.concat(features);
}


interface RootFNode extends FNode {

}

export interface FNode {
    id: string;
    // version: string;
    options?: string | boolean | Record<string, string | boolean | undefined>;
    dependsOn: FNode[];
}

function fNodeEquality(a: FNode, b: FNode) {
    if (a.id !== b.id) {
        return false;
    }
    // Compare options Record by stringifying them.  This isn't fully correct.
    if (JSON.stringify(a.options) !== JSON.stringify(b.options)) {
        return false;
    }

    return true;
}

function fNodeStableSort(a: FNode, b: FNode) {
    if (a.id !== b.id) {
        return a.id.localeCompare(b.id);
    }

    if (JSON.stringify(a.options) !== JSON.stringify(b.options)) {
        // This isn't totally correct, but gives the right idea.
        return JSON.stringify(a.options).localeCompare(JSON.stringify(b.options));
    }
    return 0;
}

async function _buildDependencyGraph(params: CommonParams, worklist: FNode[], acc: FNode[]): Promise<FNode[]> {

    while (worklist.length > 0) {
        const current = worklist.shift()!;

        // If the current feature is already in the accumulator (according to fNodeEquality), skip it.
        if (acc.some(f => fNodeEquality(f, current))) {
            continue;
        }

        params.output.write(`Resolving dependencies for '${current.id}'...`, LogLevel.Info);
        // Fetch the manifest of the Feature and read its 'dev.containers.experimental.dependsOn' label
        const manifest = await fetchOCIFeatureManifestIfExistsFromUserIdentifier(params, current.id);
        if (!manifest) {
            throw new Error(`Manifest for '${current.id}' not found`);
        }

        const dependsOnSerialized = manifest.annotations?.['dev.containers.experimental.dependsOn'];

        if (!dependsOnSerialized) {
            acc.push(current);
            continue;
        }

        const dependsOn = JSON.parse(dependsOnSerialized) as Record<string, string | boolean | Record<string, string | boolean>>;

        for (const [id, options] of Object.entries(dependsOn)) {
            const ref = getRef(params.output, id);
            if (!ref) {
                throw new Error(`Invalid reference '${id}'`);
            }
            const dependency = {
                id: ref.resource,
                // version: 'latest',
                options,
                dependsOn: [],
            };
            current.dependsOn.push(dependency);
            worklist.push(dependency);
        }

        acc.push(current);
        await _buildDependencyGraph(params, worklist, acc);
    }

    return acc;
}

export async function buildDependencyGraphFromFeatureRef(params: CommonParams, featureRef: OCIRef): Promise<FNode[]> {

    const rootNodes = {
        id: featureRef.resource,
        // version: feature.sourceInformation.userFeatureId.split(':')[1],
        dependsOn: [],
    };

    const nodes: FNode[] = [];
    return await _buildDependencyGraph(params, [rootNodes], nodes);
}

// Creates the directed asyclic graph (DAG) of Features and their dependencies (dependsOn).
export async function buildDependencyGraphFromConfig(params: CommonParams, config: DevContainerConfig): Promise<FNode[]> {

    const userFeatures = userFeaturesToArray(config);
    if (!userFeatures) {
        throw new Error('No features found. Nothing to do.');
    }

    const rootNodes =
        userFeatures.map<RootFNode>(f => {
            const ref = getRef(params.output, f.id);
            if (!ref) {
                throw new Error(`Invalid reference '${f.id}'`);
            }
            return {
                id: ref.resource,
                // version: feature.sourceInformation.userFeatureId.split(':')[1],
                options: f.options,
                dependsOn: [],
            };
        });

    const nodes: FNode[] = [];
    return await _buildDependencyGraph(params, rootNodes, nodes);
}

export async function computeDependsOnInstallationOrder(params: CommonParams, config: DevContainerConfig) {
    const worklist = await buildDependencyGraphFromConfig(params, config);

    params.output.write(`Starting with: ${worklist.map(n => n.id).join(', ')}`, LogLevel.Info);

    const installationOrder: FNode[] = [];
    while (worklist.length > 0) {
        const round = worklist.filter(node =>
            node.dependsOn.length === 0
            || node.dependsOn.every(dep =>
                installationOrder.some(installed => fNodeEquality(installed, dep))));

        params.output.write(`Round: ${round.map(r => r.id).join(', ')}`, LogLevel.Info);

        if (round.length === 0) {
            params.output.write(`Nodes remaining: ${worklist.map(n => n.id).join(', ')}`, LogLevel.Error);
            throw new Error('Circular dependency detected');
        }

        // Delete all nodes present in this round from the worklist.
        worklist.splice(0, worklist.length, ...worklist.filter(node => !round.some(r => fNodeEquality(r, node))));

        // Sort rounds lexicographically by id.
        round.sort((a, b) => fNodeStableSort(a, b));

        installationOrder.push(...round);
    }

    return installationOrder;
}

// Exported for unit tests.
export function computeInstallationOrder(features: FeatureSet[]) {
    const nodesById = features.map<FeatureNode>(feature => ({
        feature,
        before: new Set(),
        after: new Set(),
    })).reduce((map, feature) => map.set(feature.feature.sourceInformation.userFeatureId.split(':')[0], feature), new Map<string, FeatureNode>());

    let nodes = [...nodesById.values()];

    // Currently legacyIds only contain an id, hence append `registry/namespace` to it.
    nodes = nodes.map(node => {
        if (node.feature.sourceInformation.type === 'oci' && node.feature.features[0].legacyIds && node.feature.features[0].legacyIds.length > 0) {
            const featureRef = node.feature.sourceInformation.featureRef;
            if (featureRef) {
                node.feature.features[0].legacyIds = node.feature.features[0].legacyIds.map(legacyId => `${featureRef.registry}/${featureRef.namespace}/` + legacyId);
                node.feature.features[0].currentId = `${featureRef.registry}/${featureRef.namespace}/${node.feature.features[0].currentId}`;
            }
        }
        return node;
    });

    for (const later of nodes) {
        for (const firstId of later.feature.features[0].installsAfter || []) {
            let first = nodesById.get(firstId);

            // Check for legacyIds (back compat)
            if (!first) {
                first = nodes.find(node => node.feature.features[0].legacyIds?.includes(firstId));
            }

            // Check for currentId (forward compat)
            if (!first) {
                first = nodes.find(node => node.feature.features[0].currentId === firstId);
            }

            // soft dependencies
            if (first) {
                later.after.add(first);
                first.before.add(later);
            }
        }
    }

    const { roots, islands } = nodes.reduce((prev, node) => {
        if (node.after.size === 0) {
            if (node.before.size === 0) {
                prev.islands.push(node);
            } else {
                prev.roots.push(node);
            }
        }
        return prev;
    }, { roots: [] as FeatureNode[], islands: [] as FeatureNode[] });

    const orderedFeatures = [];
    let current = roots;
    while (current.length) {
        const next = [];
        for (const first of current) {
            for (const later of first.before) {
                later.after.delete(first);
                if (later.after.size === 0) {
                    next.push(later);
                }
            }
        }
        orderedFeatures.push(
            ...current.map(node => node.feature)
                .sort((a, b) => a.sourceInformation.userFeatureId < b.sourceInformation.userFeatureId ? -1 : 1) // stable order
        );
        current = next;
    }

    orderedFeatures.push(
        ...islands.map(node => node.feature)
            .sort((a, b) => a.sourceInformation.userFeatureId < b.sourceInformation.userFeatureId ? -1 : 1) // stable order
    );

    const missing = new Set(nodesById.keys());
    for (const feature of orderedFeatures) {
        missing.delete(feature.sourceInformation.userFeatureId.split(':')[0]);
    }

    if (missing.size !== 0) {
        throw new Error(`Features declare cyclic dependency: ${[...missing].join(', ')}`);
    }

    return orderedFeatures;
}