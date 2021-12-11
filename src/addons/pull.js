/**
 * Copyright (C) 2021 Thomas Weber
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* eslint-disable import/no-commonjs */
/* eslint-disable import/no-nodejs-modules */
/* eslint-disable no-console */
/* global __dirname */

const fs = require('fs');
const childProcess = require('child_process');
const rimraf = require('rimraf');
const request = require('request');
const pathUtil = require('path');
const {addons, newAddons} = require('./addons.js');

const walk = dir => {
    const children = fs.readdirSync(dir);
    const files = [];
    for (const child of children) {
        const path = pathUtil.join(dir, child);
        const stat = fs.statSync(path);
        if (stat.isDirectory()) {
            const childChildren = walk(path);
            for (const childChild of childChildren) {
                files.push(pathUtil.join(child, childChild));
            }
        } else {
            files.push(child);
        }
    }
    return files;
};

const clone = obj => JSON.parse(JSON.stringify(obj));

const repoPath = pathUtil.resolve(__dirname, 'ScratchAddons');
if (!process.argv.includes('-')) {
    rimraf.sync(repoPath);
    childProcess.execSync(`git clone --depth=1 https://github.com/TurboWarp/addons ${repoPath}`);
}

for (const folder of ['addons', 'addons-l10n', 'addons-l10n-settings', 'libraries']) {
    const path = pathUtil.resolve(__dirname, folder);
    rimraf.sync(path);
    fs.mkdirSync(path, {recursive: true});
}

const generatedPath = pathUtil.resolve(__dirname, 'generated');
rimraf.sync(generatedPath);
fs.mkdirSync(generatedPath, {recursive: true});

process.chdir(repoPath);
const commitHash = childProcess.execSync('git rev-parse --short HEAD')
    .toString()
    .trim();

request('https://raw.githubusercontent.com/ScratchAddons/contributors/master/.all-contributorsrc', (err, response, body) => {
    const parsed = JSON.parse(body);
    const contributors = parsed.contributors.filter(({contributions}) => contributions.includes('translation'));
    const contributorsPath = pathUtil.resolve(generatedPath, 'translators.json');
    fs.writeFileSync(contributorsPath, JSON.stringify(contributors, null, 4));
});

const matchAll = (str, regex) => {
    const matches = [];
    let match;
    while ((match = regex.exec(str)) !== null) {
        matches.push(match);
    }
    return matches;
};

const includeImportedLibraries = contents => {
    // Parse things like:
    // import { normalizeHex, getHexRegex } from "../../libraries/normalize-color.js";
    // import RateLimiter from "../../libraries/rate-limiter.js";
    const matches = matchAll(
        contents,
        /import +(?:{.*}|.*) +from +["']\.\.\/\.\.\/libraries\/([\w\d_\/-]+(?:\.esm)?\.js)["'];/g
    );
    for (const match of matches) {
        const libraryFile = match[1];
        const oldLibraryPath = pathUtil.resolve(__dirname, 'ScratchAddons', 'libraries', libraryFile);
        const newLibraryPath = pathUtil.resolve(__dirname, 'libraries', libraryFile);
        const libraryContents = fs.readFileSync(oldLibraryPath, 'utf-8');
        const newLibraryDirName = pathUtil.dirname(newLibraryPath);
        fs.mkdirSync(newLibraryDirName, {
            recursive: true
        });
        fs.writeFileSync(newLibraryPath, libraryContents);
    }
};

const includePolyfills = contents => {
    if (contents.includes('EventTarget')) {
        contents = `import EventTarget from "../../event-target.js"; /* inserted by pull.js */\n\n${contents}`;
    }
    return contents;
};

const includeImports = (folder, contents) => {
    const dynamicAssets = walk(folder)
        .filter(file => file.endsWith('.svg') || file.endsWith('.png'));

    const stringifyPath = path => JSON.stringify(path).replace(/\\\\/g, '/');

    // Then we'll generate some JS to import them.
    let header = '/* inserted by pull.js */\n';
    dynamicAssets.forEach((file, index) => {
        header += `import _twAsset${index} from ${stringifyPath(`!url-loader!./${file}`)};\n`;
    });
    header += `const _twGetAsset = (path) => {\n`;
    dynamicAssets.forEach((file, index) => {
        header += `  if (path === ${stringifyPath(`/${file}`)}) return _twAsset${index};\n`;
    });
    // eslint-disable-next-line no-template-curly-in-string
    header += '  throw new Error(`Unknown asset: ${path}`);\n';
    header += '};\n';
    header += '\n';

    // And now we reroute everything to use our imports.
    // Parse things like:
    // el.src = addon.self.dir + "/" + name + ".svg";
    //          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  match
    //                           ^^^^^^^^^^^^^^^^^^^  capture group 1
    contents = contents.replace(
        /\${addon\.self\.(?:dir|lib) *\+ *([^;\n]+)}/g,
        (_fullText, name) => `\${_twGetAsset(${name})}`
    );
    contents = contents.replace(
        /addon\.self\.(?:dir|lib) *\+ *([^;,\n]+)/g,
        (_fullText, name) => `_twGetAsset(${name})`
    );

    return header + contents;
};

const generateManifestEntry = (id, manifest) => {
    const KEEP_TAGS = [
        'recommended',
        'theme',
        'beta',
        'danger'
    ];
    manifest.tags = manifest.tags.filter(i => KEEP_TAGS.includes(i));
    if (newAddons.includes(id)) {
        manifest.tags.push('new');
    }

    const trimmedManifest = clone(manifest);
    delete trimmedManifest.versionAdded;
    delete trimmedManifest.libraries;
    delete trimmedManifest.injectAsStyleElt;
    delete trimmedManifest.enabledByDefaultMobile;
    delete trimmedManifest.permissions;
    if (trimmedManifest.userscripts) {
        for (const userscript of trimmedManifest.userscripts) {
            delete userscript.matches;
            delete userscript.runAtComplete;
        }
    }
    if (trimmedManifest.userstyles) {
        for (const userstyle of trimmedManifest.userstyles) {
            delete userstyle.matches;
        }
    }

    let result = '/* generated by pull.js */\n';
    result += `const manifest = ${JSON.stringify(trimmedManifest, null, 2)};\n`;
    if (typeof manifest.enabledByDefaultMobile === 'boolean') {
        result += 'import {isMobile} from "../../environment";\n';
        result += `if (isMobile) manifest.enabledByDefault = ${manifest.enabledByDefaultMobile};\n`;
    }
    if (manifest.permissions && manifest.permissions.includes('clipboardWrite')) {
        result += 'import {clipboardSupported} from "../../environment";\n';
        result += `if (!clipboardSupported) manifest.unsupported = true;\n`;
    }
    if (id === 'mediarecorder') {
        result += 'import {mediaRecorderSupported} from "../../environment";\n';
        result += `if (!mediaRecorderSupported) manifest.unsupported = true;\n`;
    }
    result += `export default manifest;\n`;
    return result;
};

const generateRuntimeEntry = (id, manifest) => {
    let result = '/* generated by pull.js */\n';
    result += 'export const resources = {\n';
    for (const {url} of manifest.userscripts || []) {
        result += `  ${JSON.stringify(url)}: () => require(${JSON.stringify(`./${url}`)}),\n`;
    }
    for (const {url} of manifest.userstyles || []) {
        result += `  ${JSON.stringify(url)}: () => require(${JSON.stringify(`!css-loader!./${url}`)}),\n`;
    }
    result += '};\n';
    return result;
};

const addonIdToManifest = {};
const processAddon = (id, oldDirectory, newDirectory) => {
    for (const file of walk(oldDirectory)) {
        const oldPath = pathUtil.join(oldDirectory, file);
        let contents = fs.readFileSync(oldPath);

        const newPath = pathUtil.join(newDirectory, file);
        fs.mkdirSync(pathUtil.dirname(newPath), {recursive: true});

        if (file === 'addon.json') {
            contents = contents.toString('utf-8');
            const parsedManifest = JSON.parse(contents);
            addonIdToManifest[id] = parsedManifest;
            const settingsEntryPath = pathUtil.join(newDirectory, '_manifest_entry.js');
            fs.writeFileSync(settingsEntryPath, generateManifestEntry(id, parsedManifest));
            const runtimeEntryPath = pathUtil.join(newDirectory, '_runtime_entry.js');
            fs.writeFileSync(runtimeEntryPath, generateRuntimeEntry(id, parsedManifest));
            continue;
        }

        if (file.endsWith('.js')) {
            contents = contents.toString('utf-8');
            includeImportedLibraries(contents);
            contents = includePolyfills(contents);
            if (contents.includes('addon.self.dir') || contents.includes('addon.self.lib')) {
                contents = includeImports(oldDirectory, contents);
            }
        }

        fs.writeFileSync(newPath, contents);
    }
};

const SKIP_MESSAGES = [
    'debugger/feedback-log',
    'debugger/feedback-log-link',
    'debugger/feedback-remove',
    'editor-devtools/help-by',
    'editor-devtools/extension-description-not-for-addon',
    'mediarecorder/added-by',
    'editor-theme3/@settings-name-sa-color',
    'block-switching/@settings-name-sa'
];

const parseMessages = localePath => {
    const settings = {};
    const runtime = {};
    for (const addon of addons) {
        const path = pathUtil.join(localePath, `${addon}.json`);
        try {
            const contents = fs.readFileSync(path, 'utf-8');
            const parsed = JSON.parse(contents);
            for (const id of Object.keys(parsed).sort()) {
                if (SKIP_MESSAGES.includes(id)) {
                    continue;
                }
                const value = parsed[id];
                if (id.includes('/@')) {
                    settings[id] = value;
                } else {
                    runtime[id] = value;
                }
            }
        } catch (e) {
            // Ignore
        }
    }
    return {
        settings,
        runtime
    };
};

const generateEntries = (items, callback) => {
    let importSection = '';
    let importCount = 0;
    let exportSection = 'export default {\n';
    for (const i of items) {
        const {src, name, type} = callback(i);
        if (type === 'lazy-import') {
            // eslint-disable-next-line max-len
            exportSection += `  ${JSON.stringify(i)}: () => import(/* webpackChunkName: ${JSON.stringify(name)} */ ${JSON.stringify(src)}),\n`;
        } else if (type === 'lazy-require') {
            exportSection += `  ${JSON.stringify(i)}: () => require(${JSON.stringify(src)}),\n`;
        } else if (type === 'eager-import') {
            const importName = `_import${importCount}`;
            importCount++;
            importSection += `import ${importName} from ${JSON.stringify(src)};\n`;
            exportSection += `  ${JSON.stringify(i)}: ${importName},\n`;
        } else {
            throw new Error(`Unknown type: ${type}`);
        }
    }
    exportSection += '};\n';
    let result = '/* generated by pull.js */\n';
    result += importSection;
    result += exportSection;
    return result;
};

const generateL10nEntries = locales => generateEntries(
    locales.filter(i => i !== 'en'),
    locale => ({
        name: `addon-l10n-${locale}`,
        src: `../addons-l10n/${locale}.json`,
        type: 'lazy-import'
    })
);

const generateL10nSettingsEntries = locales => generateEntries(
    locales.filter(i => i !== 'en'),
    locale => ({
        src: `../addons-l10n-settings/${locale}.json`,
        type: 'lazy-require'
    })
);

const generateRuntimeEntries = () => generateEntries(
    addons,
    id => {
        const manifest = addonIdToManifest[id];
        return {
            src: `../addons/${id}/_runtime_entry.js`,
            // Include default addons in a single bundle
            name: manifest.enabledByDefault ? 'addon-default-entry' : `addon-entry-${id}`,
            // Include default addons useful outside of the editor in the original bundle, no request required
            type: (manifest.enabledByDefault && !manifest.editorOnly) ? 'lazy-require' : 'lazy-import'
        };
    }
);

const generateManifestEntries = () => generateEntries(
    addons,
    id => ({
        src: `../addons/${id}/_manifest_entry.js`,
        type: 'eager-import'
    })
);

for (const addon of addons) {
    const oldDirectory = pathUtil.resolve(__dirname, 'ScratchAddons', 'addons', addon);
    const newDirectory = pathUtil.resolve(__dirname, 'addons', addon);
    processAddon(addon, oldDirectory, newDirectory);
}

const l10nFiles = fs.readdirSync(pathUtil.resolve(__dirname, 'ScratchAddons', 'addons-l10n'));
const languages = [];
for (const file of l10nFiles) {
    const oldDirectory = pathUtil.resolve(__dirname, 'ScratchAddons', 'addons-l10n', file);
    // Ignore README
    if (!fs.statSync(oldDirectory).isDirectory()) {
        continue;
    }
    // Convert pt-br to just pt
    const fixedName = file === 'pt-br' ? 'pt' : file;
    languages.push(fixedName);
    const runtimePath = pathUtil.resolve(__dirname, 'addons-l10n', `${fixedName}.json`);
    const settingsPath = pathUtil.resolve(__dirname, 'addons-l10n-settings', `${fixedName}.json`);
    const {settings, runtime} = parseMessages(oldDirectory);
    fs.writeFileSync(runtimePath, JSON.stringify(runtime));
    if (fixedName !== 'en') {
        fs.writeFileSync(settingsPath, JSON.stringify(settings));
    }
}

fs.writeFileSync(pathUtil.resolve(generatedPath, 'l10n-entries.js'), generateL10nEntries(languages));
fs.writeFileSync(pathUtil.resolve(generatedPath, 'l10n-settings-entries.js'), generateL10nSettingsEntries(languages));
fs.writeFileSync(pathUtil.resolve(generatedPath, 'addon-entries.js'), generateRuntimeEntries(languages));
fs.writeFileSync(pathUtil.resolve(generatedPath, 'addon-manifests.js'), generateManifestEntries(languages));

const upstreamMetaPath = pathUtil.resolve(generatedPath, 'upstream-meta.json');
fs.writeFileSync(upstreamMetaPath, JSON.stringify({
    commit: commitHash
}));