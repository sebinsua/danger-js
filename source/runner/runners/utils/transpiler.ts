import fs from "fs"
import path from "path"
import JSON5 from "json5"
import { debug } from "../../../debug"

const d = debug("transpiler:setup")

let hasChecked = false
let hasNativeTypeScript = false
let hasBabel = false
let hasBabelTypeScript = false
let hasFlow = false

const checkForPackage = (pkgs: string | ReadonlyArray<string>): boolean => {
  const packages = Array.isArray(pkgs) ? pkgs : [pkgs]

  for (const pkg of packages) {
    try {
      require.resolve(pkg) // tslint:disable-line
      return true
    } catch (err) {
      continue
    }
  }

  return false
}

const whichPackage = (pkgs: string | ReadonlyArray<string>): string => {
  const packages = Array.isArray(pkgs) ? pkgs : [pkgs]

  for (const pkg of packages) {
    try {
      return require.resolve(pkg) // tslint:disable-line
    } catch (err) {
      continue
    }
  }

  throw new Error(`whichPackage() could not resolve a package for: ${packages.join(", ")}`)
}

export const checkForNodeModules = () => {
  hasNativeTypeScript = checkForPackage("typescript")
  if (!hasNativeTypeScript) {
    d("Does not have TypeScript set up")
  }

  hasBabel = checkForPackage(["@babel/core", "babel-core"])
  if (!hasBabel) {
    d("Does not have Babel set up")
  } else {
    require(whichPackage(["@babel/polyfill", "babel-polyfill"]))
  }

  hasBabelTypeScript = checkForPackage(["@babel/plugin-transform-typescript", "babel-plugin-transform-typescript"])
  if (!hasBabelTypeScript) {
    d("Does not have Babel 7 TypeScript set up")
  }

  hasFlow = checkForPackage(["@babel/plugin-transform-flow-strip-types", "babel-plugin-transform-flow-strip-types"])
  if (!hasFlow) {
    d("Does not have Flow set up")
  }

  hasChecked = true
}

// Now that we have a sense of what exists inside the users' node modules

export const typescriptify = (content: string): string => {
  const ts = require("typescript") // tslint:disable-line

  const compilerOptions = JSON5.parse(fs.readFileSync("tsconfig.json", "utf8"))
  let result = ts.transpileModule(content, sanitizeTSConfig(compilerOptions))
  return result.outputText
}

const sanitizeTSConfig = (config: any) => {
  if (!config.compilerOptions) {
    return config
  }

  const safeConfig = config

  // It can make sense to ship TS code with modules
  // for `import`/`export` syntax, but as we're running
  // the transpiled code on vanilla node - it'll need to
  // be used with plain old commonjs
  //
  // @see https://github.com/apollographql/react-apollo/pull/1402#issuecomment-351810274
  //
  if (safeConfig.compilerOptions.module) {
    safeConfig.compilerOptions.module = "commonjs"
  }

  return safeConfig
}

const isPluginWithinBabelConfig = (plugins: any[], pluginName: string): boolean => {
  if (!plugins.length) {
    return false
  }

  return plugins.some((plugin: any) => plugin.file.request.includes(pluginName))
}

const filterPlugin = (plugins: any[], pluginName: string): string[] => {
  if (!plugins.length) {
    return plugins
  }

  return plugins.filter((plugin: any) => plugin.file.request.includes(pluginName))
}

export const babelify = (babel: any, content: string, filename: string, plugins: string[]): string => {
  if (!babel.transform) {
    return content
  }

  const fileOpts = {
    filename,
    filenameRelative: filename,
    sourceMap: false,
    sourceFileName: undefined,
    sourceType: "module",
    plugins,
  }

  const result = babel.transform(content, fileOpts)

  return result.code
}

export default (code: string, filename: string) => {
  if (!hasChecked) {
    checkForNodeModules()
  }

  const filetype = path.extname(filename)
  const isModule = filename.includes("node_modules")
  if (isModule) {
    return code
  }

  let result = code
  if (filetype.startsWith(".ts") && hasBabel && hasBabelTypeScript) {
    const babel = require(whichPackage(["@babel/core", "babel-core"]))

    const { options } = babel.loadPartialConfig ? babel.loadPartialConfig() : { options: { plugins: [] } }

    const pluginsWithoutFlow = filterPlugin(options.plugins, "plugin-transform-flow-strip-types")

    const withoutTypeScript = !isPluginWithinBabelConfig(pluginsWithoutFlow, "plugin-transform-typescript")

    const plugins =
      withoutTypeScript && hasBabelTypeScript
        ? [
            whichPackage(["@babel/plugin-transform-typescript", "babel-plugin-transform-typescript"]),
            ...pluginsWithoutFlow,
          ]
        : pluginsWithoutFlow

    result = babelify(babel, code, filename, plugins)
  } else if (filetype.startsWith(".ts") && hasNativeTypeScript) {
    result = typescriptify(code)
  } else if (filetype.startsWith(".js") && hasBabel) {
    const babel = require(whichPackage(["@babel/core", "babel-core"]))

    const { options } = babel.loadPartialConfig ? babel.loadPartialConfig() : { options: { plugins: [] } }

    const pluginsWithoutTypeScript = filterPlugin(options.plugins, "plugin-transform-typescript")

    const withoutFlow = !isPluginWithinBabelConfig(pluginsWithoutTypeScript, "plugin-transform-flow-strip-types")

    const plugins =
      withoutFlow && hasFlow
        ? [
            whichPackage(["@babel/plugin-transform-flow-strip-types", "babel-plugin-transform-flow-strip-types"]),
            ...pluginsWithoutTypeScript,
          ]
        : pluginsWithoutTypeScript

    result = babelify(babel, code, filename, plugins)
  }

  return result
}
