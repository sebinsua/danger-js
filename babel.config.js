module.exports = {
  presets: ["@babel/preset-es2015", "@babel/preset-stage-3"],
  plugins: [
    "syntax-async-functions",
    "@babel/plugin-proposal-class-properties",
    "@babel/plugin-transform-regenerator",
    "@babel/plugin-transform-flow-strip-types",
  ],
}
