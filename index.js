var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var level = require('level');
var lodash = require('lodash');
var mkdirp = require('mkdirp');

var Promise = require('bluebird');

var envHash;
try {
  envHash = require('env-hash');
  envHash = envHash.default || envHash;
}
catch (_) {
  envHash = function() {
    return Promise.resolve('');
  };
}

var AMDDefineDependency = require('webpack/lib/dependencies/AMDDefineDependency');
var AsyncDependenciesBlock = require('webpack/lib/AsyncDependenciesBlock');
var ConstDependency = require('webpack/lib/dependencies/ConstDependency');
var ContextDependency = require('webpack/lib/dependencies/ContextDependency');
var NormalModule = require('webpack/lib/NormalModule');
var NullDependencyTemplate = require('webpack/lib/dependencies/NullDependencyTemplate');
var NullFactory = require('webpack/lib/NullFactory');
var SingleEntryDependency = require('webpack/lib/dependencies/SingleEntryDependency');

var HarmonyImportDependency, HarmonyImportSpecifierDependency, HarmonyExportImportedSpecifierDependency;

try {
  HarmonyImportDependency = require('webpack/lib/dependencies/HarmonyImportDependency');
  HarmonyImportSpecifierDependency = require('webpack/lib/dependencies/HarmonyImportSpecifierDependency');
  HarmonyExportImportedSpecifierDependency = require('webpack/lib/dependencies/HarmonyExportImportedSpecifierDependency');
}
catch (_) {}

var HardModuleDependency = require('./lib/dependencies').HardModuleDependency;
var HardContextDependency = require('./lib/dependencies').HardContextDependency;
var HardNullDependency = require('./lib/dependencies').HardNullDependency;
var HardHarmonyExportDependency = require('./lib/dependencies').HardHarmonyExportDependency;
var HardHarmonyImportDependency =
require('./lib/dependencies').HardHarmonyImportDependency;
var HardHarmonyImportSpecifierDependency =
require('./lib/dependencies').HardHarmonyImportSpecifierDependency;
var HardHarmonyExportImportedSpecifierDependency = require('./lib/dependencies').HardHarmonyExportImportedSpecifierDependency;

var FileSerializer = require('./lib/cache-serializers').FileSerializer;
var HardModule = require('./lib/hard-module');
var LevelDbSerializer = require('./lib/cache-serializers').LevelDbSerializer;
var makeDevtoolOptions = require('./lib/devtool-options');

function requestHash(request) {
  return crypto.createHash('sha1').update(request).digest().hexSlice();
}

function md5(file, inputFileSystem) {
  return Promise.resolve({
    then: function(resolve, reject) {
      inputFileSystem.readFile(file, function(err, contents) {
        if (err) { return reject(err); }
        return resolve(crypto.createHash('md5').update(contents, 'utf8').digest('hex'));
      });
    }
  });
}

var fsReadFile = Promise.promisify(fs.readFile, {context: fs});
var fsStat = Promise.promisify(fs.stat, {context: fs});
var fsWriteFile = Promise.promisify(fs.writeFile, {context: fs});

var NS, extractTextNS;

NS = fs.realpathSync(__dirname);

try {
  extractTextNS = path.dirname(require.resolve('extract-text-webpack-plugin'));
}
catch (_) {}

var cachePrefixNS = NS + '/cachePrefix';
var cachePrefixErrorOnce = true;

function cachePrefix(compilation) {
  if (typeof compilation[cachePrefixNS] === 'undefined') {
    var prefix = '';
    var nextCompilation = compilation;

    while (nextCompilation.compiler.parentCompilation) {
      var parentCompilation = nextCompilation.compiler.parentCompilation;
      if (!nextCompilation.cache) {
        if (cachePrefixErrorOnce) {
          cachePrefixErrorOnce = false;
          console.error([
            'A child compiler (' + compilation.compiler.name + ') does not',
            'have a memory cache. Enable a memory cache with webpack\'s',
            '`cache` configuration option. HardSourceWebpackPlugin will be',
            'disabled for this child compiler until then.',
          ].join('\n'));
        }
        prefix = null;
        break;
      }

      var cache = nextCompilation.cache;
      var parentCache = parentCompilation.cache;

      if (cache === parentCache) {
        nextCompilation = parentCompilation;
        continue;
      }

      var cacheKey;
      for (var key in parentCache) {
        if (key && parentCache[key] === cache) {
          cacheKey = key;
          break;
        }
      }

      if (!cacheKey) {
        if (cachePrefixErrorOnce) {
          cachePrefixErrorOnce = false;
          console.error([
            'A child compiler (' + compilation.compiler.name + ') has a',
            'memory cache but its cache name is unknown.',
            'HardSourceWebpackPlugin will be disabled for this child',
            'compiler.',
          ].join('\n'));
        }
        prefix = null;
        break;
      }
      else {
        prefix = cacheKey + prefix;
      }

      nextCompilation = parentCompilation;
    }

    compilation[cachePrefixNS] = prefix;
  }

  return compilation[cachePrefixNS];
}

function flattenPrototype(obj) {
  var copy = {};
  for (var key in obj) {
    copy[key] = obj[key];
  }
  return copy;
}

function serializeDependencies(deps) {
  return deps
  .map(function(dep) {
    if (typeof HarmonyImportDependency !== 'undefined') {
      if (dep instanceof HarmonyImportDependency) {
        return {
          harmonyImport: true,
          request: dep.request,
        };
      }
      if (dep instanceof HarmonyExportImportedSpecifierDependency) {
        return {
          harmonyRequest: dep.importDependency.request,
          harmonyExportImportedSpecifier: true,
          harmonyId: dep.id,
          harmonyName: dep.name,
        };
      }
      if (dep instanceof HarmonyImportSpecifierDependency) {
        return {
          harmonyRequest: dep.importDependency.request,
          harmonyImportSpecifier: true,
          harmonyId: dep.id,
          harmonyName: dep.name,
          loc: dep.loc,
        };
      }
    }
    if (dep.originModule) {
      return {
        harmonyExport: true,
        harmonyId: dep.id,
        harmonyName: dep.describeHarmonyExport().exportedName,
        harmonyPrecedence: dep.describeHarmonyExport().precedence,
      };
    }
    return {
      contextDependency: dep instanceof ContextDependency,
      contextCritical: dep.critical,
      constDependency: (
        dep instanceof ConstDependency ||
        dep instanceof AMDDefineDependency
      ),
      request: dep.request,
      recursive: dep.recursive,
      regExp: dep.regExp ? dep.regExp.source : null,
      loc: flattenPrototype(dep.loc),
    };
  })
  .filter(function(req) {
    return req.request || req.constDependency || req.harmonyExport || req.harmonyImportSpecifier || req.harmonyExportImportedSpecifier;
  });
}
function serializeVariables(vars) {
  return vars.map(function(variable) {
    return {
      name: variable.name,
      expression: variable.expression,
      dependencies: serializeDependencies(variable.dependencies),
    }
  });
}
function serializeBlocks(blocks) {
  return blocks.map(function(block) {
    return {
      async: block instanceof AsyncDependenciesBlock,
      name: block.chunkName,
      dependencies: serializeDependencies(block.dependencies),
      variables: serializeVariables(block.variables),
      blocks: serializeBlocks(block.blocks),
    };
  });
}
function serializeHashContent(module) {
  var content = [];
  module.updateHash({
    update: function(str) {
      content.push(str);
    },
  });
  return content.join('');
}

// function AssetCache() {
//
// }
//
// function ModuleCache() {
//   this.cache = {};
//   this.serializer = null;
// }
//
// ModuleCache.prototype.get = function(identifier) {
//
// };
//
// ModuleCache.prototype.save = function(modules) {
//
// };

function HardSourceWebpackPlugin(options) {
  this.options = options;
}

HardSourceWebpackPlugin.prototype.getPath = function(dirName, suffix) {
  var confighashIndex = dirName.search(/\[confighash\]/);
  if (confighashIndex !== -1) {
    dirName = dirName.replace(/\[confighash\]/, this.configHash);
  }
  var cachePath = path.resolve(
    process.cwd(), this.compilerOutputOptions.path, dirName
  );
  if (suffix) {
    cachePath = path.join(cachePath, suffix);
  }
  return cachePath;
};

HardSourceWebpackPlugin.prototype.getCachePath = function(suffix) {
  return this.getPath(this.options.cacheDirectory, suffix);
};

module.exports = HardSourceWebpackPlugin;
HardSourceWebpackPlugin.prototype.apply = function(compiler) {
  var options = this.options;
  var active = true;
  if (!options.cacheDirectory) {
    console.error('HardSourceWebpackPlugin requires a cacheDirectory setting.');
    active = false;
    return;
  }

  this.compilerOutputOptions = compiler.options.output;
  if (options.configHash) {
    if (typeof options.configHash === 'string') {
      this.configHash = options.configHash;
    }
    else if (typeof options.configHash === 'function') {
      this.configHash = options.configHash(compiler.options);
    }
  }
  var configHashInDirectory =
    options.cacheDirectory.search(/\[confighash\]/) !== -1;
  if (configHashInDirectory && !this.configHash) {
    console.error('HardSourceWebpackPlugin cannot use [confighash] in cacheDirectory without configHash option being set and returning a non-falsy value.');
    active = false;
    return;
  }

  if (options.recordsInputPath || options.recordsPath) {
    if (compiler.options.recordsInputPath || compiler.options.recordsPath) {
      console.error('HardSourceWebpackPlugin will not set recordsInputPath when it is already set. Using current value:', compiler.options.recordsInputPath || compiler.options.recordsPath);
    }
    else {
      compiler.options.recordsInputPath =
        this.getPath(options.recordsInputPath || options.recordsPath);
    }
  }
  if (options.recordsOutputPath || options.recordsPath) {
    if (compiler.options.recordsOutputPath || compiler.options.recordsPath) {
      console.error('HardSourceWebpackPlugin will not set recordsOutputPath when it is already set. Using current value:', compiler.options.recordsOutputPath || compiler.options.recordsPath);
    }
    else {
      compiler.options.recordsOutputPath =
        this.getPath(options.recordsOutputPath || options.recordsPath);
    }
  }

  var cacheDirPath = this.getCachePath();
  var cacheAssetDirPath = path.join(cacheDirPath, 'assets');
  var resolveCachePath = path.join(cacheDirPath, 'resolve.json');

  var resolveCache = {};
  var moduleCache = {};
  var assetCache = {};
  var dataCache = {};
  var md5Cache = {};
  var currentStamp = '';

  var fileMd5s = {};
  var fileTimestamps = {};

  var assetCacheSerializer = this.assetCacheSerializer =
    new FileSerializer({cacheDirPath: path.join(cacheDirPath, 'assets')});
  var moduleCacheSerializer = this.moduleCacheSerializer =
    new LevelDbSerializer({cacheDirPath: path.join(cacheDirPath, 'modules')});
  var dataCacheSerializer = this.dataCacheSerializer =
    new LevelDbSerializer({cacheDirPath: path.join(cacheDirPath, 'data')});
  var md5CacheSerializer = this.md5CacheSerializer =
    new LevelDbSerializer({cacheDirPath: path.join(cacheDirPath, 'md5')});
  var _this = this;

  compiler.plugin('after-plugins', function() {
    if (
      !compiler.recordsInputPath || !compiler.recordsOutputPath
    ) {
      console.error('HardSourceWebpackPlugin requires recordsPath to be set.');
      active = false;
    }
  });

  compiler.plugin(['watch-run', 'run'], function(compiler, cb) {
    if (!active) {return cb();}

    try {
      fs.statSync(cacheAssetDirPath);
    }
    catch (_) {
      mkdirp.sync(cacheAssetDirPath);
      if (configHashInDirectory) {
        console.log('HardSourceWebpackPlugin is writing to a new confighash path for the first time:', cacheDirPath);
      }
    }
    var start = Date.now();

    Promise.all([
      fsReadFile(path.join(cacheDirPath, 'stamp'), 'utf8')
      .catch(function() {return '';}),

      (function() {
        if (options.environmentPaths === false) {
          return Promise.resolve('');
        }
        return envHash(options.environmentPaths);
      })(),
    ])
    .then(function(stamps) {
      var stamp = stamps[0];
      var hash = stamps[1];

      if (!configHashInDirectory && options.configHash) {
        hash += '_' + _this.configHash;
      }

      currentStamp = hash;
      if (!hash || hash !== stamp) {
        if (hash && stamp) {
          console.error('Environment has changed (node_modules or configuration was updated).\nHardSourceWebpackPlugin will reset the cache and store a fresh one.');
        }

        // Reset the cache, we can't use it do to an environment change.
        resolveCache = {};
        moduleCache = {};
        assetCache = {};
        dataCache = {};
        md5Cache = {};
        fileTimestamps = {};
        return;
      }

      if (Object.keys(moduleCache).length) {return Promise.resolve();}

      return Promise.all([
        fsReadFile(resolveCachePath, 'utf8')
        .then(JSON.parse)
        .then(function(_resolveCache) {resolveCache = _resolveCache}),

        assetCacheSerializer.read()
        .then(function(_assetCache) {assetCache = _assetCache;}),

        moduleCacheSerializer.read()
        .then(function(_moduleCache) {moduleCache = _moduleCache;}),

        dataCacheSerializer.read()
        .then(function(_dataCache) {dataCache = _dataCache;})
        .then(function() {
          Object.keys(dataCache).forEach(function(key) {
            if (typeof dataCache[key] === 'string') {
              dataCache[key] = JSON.parse(dataCache[key]);
            }
          });
        }),

        md5CacheSerializer.read()
        .then(function(_md5Cache) {md5Cache = _md5Cache;})
      ])
      .then(function() {
        // console.log('cache in', Date.now() - start);
      });
    })
    .then(cb, cb);
  });

  compiler.plugin(['watch-run', 'run'], function(compiler, cb) {
    if (!active) {return cb();}

    if(!dataCache.fileDependencies) return cb();
    // var fs = compiler.inputFileSystem;
    var fileTs = compiler.fileTimestamps = fileTimestamps = {};

    var promises = []
    dataCache.fileDependencies.forEach(function(file) {
      promises.push(
        fsStat(file)
        .then(function(stat) {
          fileTs[file] = stat.mtime || Infinity;
        }, function(err) {
          fileTs[file] = 0;

          if (err.code === "ENOENT") {return;}
          throw err;
        })
      );

      promises.push(
        md5(file, compiler.inputFileSystem)
        .then(function(content) {
          fileMd5s[file] = content;
        }, function(err) {
          fileMd5s[file] = null;
          if (err.code === "ENOENT") {return;}
          throw err;
        })
      );
    });
    return Promise.all(promises)
    .then(function() {
      // Invalidate modules that depend on a userRequest that is no longer
      // valid.
      var walkDependencyBlock = function(block, callback) {
        block.dependencies.forEach(callback);
        block.variables.forEach(function(variable) {
          variable.dependencies.forEach(callback);
        });
        block.blocks.forEach(function(block) {
          walkDependencyBlock(block, callback);
        });
      };
      // Remove the out of date cache modules.
      Object.keys(moduleCache).forEach(function(key) {
        var cacheItem = moduleCache[key];
        if (!cacheItem) {return;}
        if (typeof cacheItem === 'string') {
          cacheItem = JSON.parse(cacheItem);
          moduleCache[key] = cacheItem;
        }
        var validDepends = true;
        walkDependencyBlock(cacheItem, function(cacheDependency) {
          if (
            !cacheDependency ||
            cacheDependency.contextDependency ||
            typeof cacheDependency.request === 'undefined'
          ) {
            return;
          }

          var resolveId = JSON.stringify(
            [cacheItem.context, cacheDependency.request]
          );
          var resolveItem = resolveCache[resolveId];
          validDepends = validDepends &&
            resolveItem &&
            resolveItem.userRequest &&
            fileTs[resolveItem.userRequest] !== 0;
        });
        if (!validDepends) {
          cacheItem.invalid = true;
          moduleCache[key] = null;
        }
      });
    })
    .then(function() {cb();}, cb);
  });

  compiler.plugin('compilation', function(compilation, params) {
    if (!active) {return;}

    compilation.fileTimestamps = fileTimestamps;

    compilation.dependencyFactories.set(HardModuleDependency, params.normalModuleFactory);
    compilation.dependencyTemplates.set(HardModuleDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardContextDependency, params.contextModuleFactory);
    compilation.dependencyTemplates.set(HardContextDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardNullDependency, new NullFactory());
    compilation.dependencyTemplates.set(HardNullDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardHarmonyExportDependency, new NullFactory());
    compilation.dependencyTemplates.set(HardHarmonyExportDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardHarmonyImportDependency, params.normalModuleFactory);
    compilation.dependencyTemplates.set(HardHarmonyImportDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardHarmonyImportSpecifierDependency, new NullFactory());
    compilation.dependencyTemplates.set(HardHarmonyImportSpecifierDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardHarmonyExportImportedSpecifierDependency, new NullFactory());
    compilation.dependencyTemplates.set(HardHarmonyExportImportedSpecifierDependency, new NullDependencyTemplate);

    var needAdditionalPass;

    compilation.plugin('after-seal', function(cb) {
      needAdditionalPass = compilation.modules.reduce(function(carry, module) {
        var cacheItem = moduleCache[module.identifier()];
        if (cacheItem && (
          !lodash.isEqual(cacheItem.used, module.used) ||
          !lodash.isEqual(cacheItem.usedExports, module.usedExports)
        )) {
          cacheItem.invalid = true;
          moduleCache[module.request] = null;
          return true;
        }
        return carry;
      }, false);
      cb();
    });

    compilation.plugin('need-additional-pass', function() {
      if (needAdditionalPass) {
        needAdditionalPass = false;
        return true;
      }
    });

    // Webpack 2 can use different parsers based on config rule sets.
    params.normalModuleFactory.plugin('parser', function(parser, options) {
      // Store the options somewhere that can not conflict with another plugin
      // on the parser so we can look it up and store those options with a
      // cached module resolution.
      parser[NS + '/parser-options'] = options;
    });

    params.normalModuleFactory.plugin('resolver', function(fn) {
      return function(request, cb) {
        var cacheId = JSON.stringify([request.context, request.request]);

        var next = function() {
          var originalRequest = request;
          return fn.call(null, request, function(err, request) {
            if (err) {
              return cb(err);
            }
            if (!request.source) {
              resolveCache[cacheId] = Object.assign({}, request, {
                parser: null,
                parserOptions: request.parser[NS + '/parser-options'],
                dependencies: null,
              });
            }
            cb.apply(null, arguments);
          });
        };

        var fromCache = function() {
          var result = Object.assign({}, resolveCache[cacheId]);
          result.dependencies = request.dependencies;
          result.parser = compilation.compiler.parser;
          if (!result.parser || !result.parser.parse) {
            result.parser = params.normalModuleFactory.getParser(result.parserOptions);
          }
          return cb(null, result);
        };

        if (resolveCache[cacheId]) {
          var userRequest = resolveCache[cacheId].userRequest;
          if (fileTimestamps[userRequest]) {
            return fromCache();
          }
          return fs.stat(userRequest, function(err) {
            if (!err) {
              return fromCache();
            }

            next();
          });
        }

        next();
      };
    });

    params.normalModuleFactory.plugin('resolver', function(fn) {
      return function(request, cb) {
        fn.call(null, request, function(err, result) {
          if (err) {return cb(err);}

          var identifierPrefix = cachePrefix(compilation);
          if (identifierPrefix === null) {
            return cb(err, result);
          }
          var identifier = identifierPrefix + result.request;

          if (moduleCache[identifier]) {
            var cacheItem = moduleCache[identifier];

            if (typeof cacheItem === 'string') {
              cacheItem = JSON.parse(cacheItem);
              moduleCache[identifier] = cacheItem;
            }
            if (Array.isArray(cacheItem.assets)) {
              cacheItem.assets = (cacheItem.assets || [])
              .reduce(function(carry, key) {
                carry[key] = assetCache[requestHash(key)];
                return carry;
              }, {});
            }

            if (!HardModule.needRebuild(
              cacheItem.buildTimestamp,
              cacheItem.fileDependencies,
              cacheItem.contextDependencies,
              // [],
              fileTimestamps,
              compiler.contextTimestamps,
              fileMd5s,
              md5Cache
            )) {
              var module = new HardModule(cacheItem);

              return cb(null, module);
            }
          }
          return cb(null, result);
        });
      };
    });

    params.normalModuleFactory.plugin('module', function(module) {
      // module.isUsed = function(exportName) {
      //   return exportName ? exportName : false;
      // };
      return module;
    });
  });

  compiler.plugin('after-compile', function(compilation, cb) {
    if (!active) {return cb();}

    var startCacheTime = Date.now();

    var devtoolOptions = makeDevtoolOptions(compiler.options);

    // fs.writeFileSync(
    //   path.join(cacheDirPath, 'file-dependencies.json'),
    //   JSON.stringify({fileDependencies: compilation.fileDependencies}),
    //   'utf8'
    // );

    var moduleOps = [];
    var dataOps = [];
    var md5Ops = [];
    var assetOps = [];

    var fileDependenciesDiff = lodash.difference(compilation.fileDependencies, dataCache.fileDependencies || []);
    if (fileDependenciesDiff.length) {
      dataCache.fileDependencies = (dataCache.fileDependencies || [])
      .concat(fileDependenciesDiff);

      dataOps.push({
        key: 'fileDependencies',
        value: JSON.stringify(dataCache.fileDependencies),
      });
    }

    // moduleCache.fileDependencies = compilation.fileDependencies;
    // moduleOps.push({
    //   type: 'put',
    //   key: 'fileDependencies',
    //   // value: JSON.stringify(compilation.fileDependencies),
    //   value: moduleCache.fileDependencies,
    // });

    // mkdirp.sync(cacheAssetDirPath);

    function walkCompilations(compilation, fn) {
      fn(compilation);
      compilation.children.forEach(function(compilation) {
        walkCompilations(compilation, fn);
      });
    }

    function serializeError(error) {
      var serialized = {
        message: error.message,
      };
      if (error.origin) {
        serialized.origin = serializeDependencies([error.origin])[0];
      }
      if (error.dependencies) {
        serialized.dependencies = serializeDependencies(error.dependencies);
      }
      return serialized;
    }
    var promises = dataCache.fileDependencies.map(function(file) {
      if (fileMd5s[file]) {
        return Promise.resolve();
      } else {
        return md5(file, compiler.inputFileSystem)
        .then(function(content) {
          fileMd5s[file] = content;
        }, function(err) {
          fileMd5s[file] = null;
          if (err.code === "ENOENT") {return;}
          throw err;
        });
      }
    });

    Promise.all(promises)
    .then(function() {
      compilation.modules.forEach(function(module) {
        var identifierPrefix = cachePrefix(compilation);
        if (identifierPrefix === null) {
          return;
        }
        var identifier = identifierPrefix + module.identifier();
        var existingCacheItem = moduleCache[identifier];

        if (
          module.request &&
          module.cacheable &&
          !(module instanceof HardModule) &&
          (module instanceof NormalModule) &&
          (
            existingCacheItem &&
            module.buildTimestamp > existingCacheItem.buildTimestamp ||
            !existingCacheItem
          )
        ) {
          var source = module.source(
            compilation.dependencyTemplates,
            compilation.moduleTemplate.outputOptions,
            compilation.moduleTemplate.requestShortener
          );
          var assets = Object.keys(module.assets || {}).map(function(key) {
            return {
              key: requestHash(key),
              value: module.assets[key].source(),
            };
          });
          moduleCache[identifier] = {
            moduleId: module.id,
            context: module.context,
            request: module.request,
            userRequest: module.userRequest,
            rawRequest: module.rawRequest,
            resource: module.resource,
            loaders: module.loaders,
            identifier: module.identifier(),
            // libIdent: module.libIdent &&
            // module.libIdent({context: compiler.options.context}),
            assets: Object.keys(module.assets || {}),
            buildTimestamp: module.buildTimestamp,
            strict: module.strict,
            meta: module.meta,
            used: module.used,
            usedExports: module.usedExports,

            rawSource: module._source ? module._source.source() : null,
            source: source.source(),
            map: devtoolOptions && source.map(devtoolOptions),
            // Some plugins (e.g. UglifyJs) set useSourceMap on a module. If that
            // option is set we should always store some source map info and
            // separating it from the normal devtool options may be necessary.
            baseMap: module.useSourceMap && source.map(),
            hashContent: serializeHashContent(module),

            dependencies: serializeDependencies(module.dependencies),
            variables: serializeVariables(module.variables),
            blocks: serializeBlocks(module.blocks),

            fileDependencies: module.fileDependencies,
            contextDependencies: module.contextDependencies,

            errors: module.errors.map(serializeError),
            warnings: module.warnings.map(serializeError),
          };

          // Custom plugin handling for common plugins.
          // This will be moved in a pluginified HardSourcePlugin.
          //
          // Ignore the modules that kick off child compilers in extract text.
          // These modules must always be built so the child compilers run so
          // that assets get built.
          if (module[extractTextNS] || module.meta[extractTextNS]) {
            moduleCache[identifier] = null;
            return;
          }

          moduleOps.push({
            key: identifier,
            value: JSON.stringify(moduleCache[identifier]),
          });

          if (fileMd5s[module.resource]) {
            md5Ops.push({
              key: module.resource,
              value: fileMd5s[module.resource]
            });
          }

          if (assets.length) {
            assetOps = assetOps.concat(assets);
          }
        }
      });

      Promise.all([
        fsWriteFile(path.join(cacheDirPath, 'stamp'), currentStamp, 'utf8'),
        fsWriteFile(resolveCachePath, JSON.stringify(resolveCache), 'utf8'),
        assetCacheSerializer.write(assetOps),
        moduleCacheSerializer.write(moduleOps),
        dataCacheSerializer.write(dataOps),
        md5CacheSerializer.write(md5Ops),
      ])
      .then(function() {
        // console.log('cache out', Date.now() - startCacheTime);
        cb();
      }, cb);
    });
  });

  // Ensure records are stored inbetween runs of memory-fs using
  // webpack-dev-middleware.
  compiler.plugin('done', function() {
    if (!active) {return;}

    fs.writeFileSync(
      path.resolve(compiler.options.context, compiler.recordsOutputPath),
      JSON.stringify(compiler.records, null, 2),
      'utf8'
    );
  });
};
