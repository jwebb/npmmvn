#!/usr/bin/env node
// (c) 2013 Jamie Webb, MIT License
// jshint node: true
"use strict";

var ChildProcess = require("child_process");
var FS = require("fs");
var FStream = require("fstream");
var Http = require("http");
var Npm = require("npm");
var Path = require("path");
var Q = require("q");
var Tar = require("tar");
var Temp = require("temp");
var Url = require("url");
var Util = require("util");
var Zlib = require("zlib");
var mkdirp = require("mkdirp");
var _ = require("lodash");

function readPackage(path) {
	console.log("Scan: " + path);
	return Q.nfcall(FS.readFile, path, "UTF-8").then(JSON.parse);
}

var knownExists = {};
function remoteExists(url) {
	if (knownExists[url]) {
		return Q.resolve(true);
	}
	var result = Q.defer();
	var call = Url.parse(url);
	call.method = "HEAD";
	call.headers = {"Connection": "close"}; // Archiva pipelining seems to be broken
	var req = Http.request(call, function (res) {
		if (res.statusCode === 200) {
			knownExists[url] = true;
			result.resolve(true);
		} else if (res.statusCode === 404) {
			result.resolve(false);
		} else {
			result.reject(new Error("Got code " + res.statusCode + " for HEAD " + url));
		}
	});
	req.on("error", function (err) {
		result.reject(err);
	});
	req.end();
	return result.promise;
}

function putFile(file, url) {
	if (knownExists[url]) {
		return Q.resolve();
	}
	knownExists[url] = true;
	var result = Q.defer();
	var call = Url.parse(url);
	call.method = "PUT";
	call.headers = {"Connection": "close"};
	var req = Http.request(call, function (res) {
		if (res.statusCode === 201) {
			result.resolve();
		} else {
			result.reject(new Error("Got code " + res.statusCode + " for PUT " + url));
		}
	});
	req.on("socket", function () { console.log("Upload: " + url); });
	req.on("error", function (err) { result.reject(err); });
	var pipe = FStream.Reader(file).pipe(req);
	return result.promise;
}

function getFile(url) {
	var tmpFile = Temp.createWriteStream("npmmvn");
	var result = Q.defer();
	var req = Http.get(url, function (res) {
		if (res.statusCode !== 200) {
			result.reject(new Error("Got code " + res.statusCode + " for GET " + url));
		} else {
			var pipe = res.pipe(tmpFile);
			tmpFile.on("finish", function () {
				result.resolve(tmpFile.path);
			});
			pipe.on("error", function (err) {
				result.reject(err);
			});
		}
	});
	req.on("socket", function () { console.log("Download: " + url); });
	req.on("error", function (err) { result.reject(err); });
	return result.promise;
}

function buildTarball(dir, name, version) {
	return Q.nfcall(Temp.open, "npmmvn").then(function (tmpFile) {
		console.log("Tar: " + name + " " + version);
		return Q.nfcall(FS.close, tmpFile.fd).then(function () {
			var result = Q.defer();
			var writer = FStream.Writer(tmpFile.path);
			var pipe = FStream.Reader({
				path: Path.join(dir, name),
				type: "Directory",
				filter: function (entry) {
					return entry.basename !== "node_modules";
				}
			}).pipe(Tar.Pack()).pipe(Zlib.createGzip()).pipe(writer);
			pipe.on("close", function () { writer.end(); result.resolve(tmpFile.path); });
			pipe.on("error", function (err) { result.reject(err); });
			return result.promise;
		});
	});
}

function extractTarball(tarball, target) {
	var result = Q.defer();
	var reader = FS.createReadStream(tarball);
	var pipe = reader.pipe(Zlib.createGunzip()).pipe(Tar.Extract({ path: target, type: "Directory" }));
	pipe.on('end', function () { result.resolve(); });
	pipe.on('error', function (err) { result.reject(err); });
	return result.promise;
}

function deployTarball(tarball, url) {
	return putFile(tarball, url).then(function () {
		console.log("Complete: " + url);
	});
}

function maybeDeploy(repo, dir, name, version) {
	var url = Url.resolve(repo, Path.join("node_modules", name, version, name + "-" + version + ".tar.gz"));
	return remoteExists(url).then(function (exists) {
		if (exists) {
			console.log("Exists: " + url);
		} else {
			return buildTarball(dir, name, version).then(function (tarball) {
				return deployTarball(tarball, url);
			});
		}
	});
}

function buildModule(repo, dir, name) {
	return readPackage(Path.join(dir, name, "package.json")).then(function (pkg) {
		var deploy = maybeDeploy(repo, dir, name, pkg.version);
		var scan = scanChildren(repo, Path.join(dir, name, "node_modules")).then(function (deps) {
			return {
				name: name,
				version: pkg.version,
				dependencies: deps
			};
		});
		return Q.all([deploy, scan]).then(function() { return scan; });
	});
}

function scanChildren(repo, dir) {
	var result = Q.defer();
	var results = [];
	var reader = FStream.Reader({ path: dir });
	reader.on("error", function (err) {
		if (err.code === "ENOENT") {
			result.resolve([]);
		} else {
			result.reject(err);
		}
	});
	reader.on("entry", function (entry) {
		if (entry.type === "Directory" && !entry.basename.match(/^\./)) {
			results.push(buildModule(repo, dir, entry.basename));
		}
	});
	reader.on("end", function () {
		result.resolve(Q.all(results));
	});
	return result.promise;
}

function installModules(repo, modules, target) {
	var work = [];

	var recurse = function (modules, target) {
		_.each(modules, function (dep) {
			var result = Q.defer();
			console.log("Check: " + Path.join(target, dep.name));
			FS.stat(Path.join(target, dep.name, "package.json"), function (err, stats) {
				if (err && err.code === 'ENOENT') {
					var url = Url.resolve(repo, Path.join('node_modules', dep.name, dep.version, dep.name + '-' + dep.version + '.tar.gz'));
					result.resolve(Q.nfcall(mkdirp, target).then(function () {
						return getFile(url).then(function(tmpFile) {
							return extractTarball(tmpFile, target).then(function () { return true; });
						});
					}));
				} else {
					result.resolve(false);
				}
			});
			work.push(result.promise);
			recurse(dep.dependencies || [], Path.join(target, dep.name, 'node_modules'));
		});
	};

	recurse(modules, target);
	return Q.all(work);
}

function writeModules(modules) {
	var json = JSON.stringify(modules, null, 4);
	return Q.nfcall(FS.writeFile, ".npmmvn.json", json);
}

function runNpmRebuild() {
	var result = Q.defer();
	Npm.load({}, function (err) {
		if (err) {
			result.reject(err);
		} else {
			Npm.commands.rebuild([], function (err) {
				if (err) {
					result.reject(err);
				} else {
					result.resolve();
				}
			});
		}
	});
	Npm.on("log", function (msg) {
		console.log(msg);
	});
	return result.promise;
}

if (process.argv.length !== 3) {
	console.log("Usage: npmmvn deploy|restore");
} else if (process.argv[2] === "deploy") {
	readPackage("package.json").done(function (pkg) {
		return scanChildren(pkg.mavenRepository, "node_modules").then(function (modules) {
			return writeModules(modules);
		});
	});
} else if (process.argv[2] == "restore") {
	readPackage("package.json").done(function (pkg) {
		return Q.nfcall(FS.readFile, ".npmmvn.json", "UTF-8").then(function (json) {
			var modules = JSON.parse(json);
			return installModules(pkg.mavenRepository, modules, "node_modules").then(function (results) {
				if (_.any(results)) {
					return runNpmRebuild().then(function () {
						console.log("Done.");
					});
				} else {
					console.log("Nothing to do.");
				}
			});
		});
	});
} else {
	console.log("Usage: npmmvn deploy|restore");
}
