//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');

/**@type {import('webpack').Configuration}*/
const config = {
    target: 'node', // vscode extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/

    entry: { extension: './src/extension.ts', cli: './src/cli/index.ts' }, // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
    output: { // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        libraryTarget: "commonjs2",
        devtoolModuleFilenameTemplate: "../[resource-path]",
    },
    devtool: 'source-map',
    // El runner de terminal se publica como binario (package.json -> bin), asi
    // que su bundle necesita el shebang. Solo ese chunk: en extension.js una
    // primera linea con # rompe la carga del editor.
    plugins: [
        new webpack.BannerPlugin({
            banner: '#!/usr/bin/env node',
            raw: true,
            entryOnly: true,
            include: /^cli\.js$/
        })
    ],
    externals: {
        vscode: "commonjs vscode" // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    },
    resolve: { // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [{
            // El runner se queda en commonjs: su `require.main === module`
            // (que decide si arranca) muere con la emision ESM, y su faker
            // va empaquetado dentro porque cli.js viaja como fichero unico.
            test: /\.ts$/,
            include: /[\\/]src[\\/]cli[\\/]/,
            use: [{
                loader: 'ts-loader',
                options: { instance: 'cli' },
            }]
        }, {
            // El resto del codigo emite ESM: con `module: commonjs` (el
            // tsconfig que usan tsc y los tests) ts-loader convierte los
            // import() dinamicos en require y webpack pierde el punto de
            // corte, asi que faker acababa DENTRO de extension.js en vez
            // de en su chunk de carga diferida.
            test: /\.ts$/,
            exclude: [/node_modules/, /[\\/]src[\\/]cli[\\/]/],
            use: [{
                loader: 'ts-loader',
                options: {
                    instance: 'resto',
                    compilerOptions: { module: 'es2020', moduleResolution: 'node' },
                },
            }]
        }]
    },
}

module.exports = config;
