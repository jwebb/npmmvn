NPMMVN
======

Hack to persist Node modules to a Maven repository, and then read them back
later. Our use-case is a Jenkins server that has no public internet access, but
that needs to run Grunt-based front-end builds. The common alternative of just
shoving `node_modules` into source control wasn't acceptable, since we found
ourselves duplicating hundreds of megabytes of modules across many
repositories.

To get started, add an extra entry to your `package.json`:

    "mavenRepository": "http://your_server/repository/your_repo"

And install `npmmvn` globally:

    `npm install -g npmmvn`

This tool provides two commands:

npmmvn deploy
-------------

You want to do this before you commit a change which requires new or updated
NPM packages.

Recursively deploys every module found in `node_modules` as a Maven artifact
with groupId `node_modules`, artifactId and version taken from each module's
`package.json`. Skips modules which already exist in the repository. Writes a
`.npmmvn.json` file which records this structure, and which should be committed
to source control.

npmmvn restore
--------------

You want to do this as part of your CI build (and also when you first check out
a repository, though I'd probably prefer to just do `npm install` in that
case).

Reads the `npmmvn.json` file and downloads and extracts every referenced
package which doesn't currently exist locally into the `node_modules`
directory. The result is the same nested dependency structure as the original.

Then runs `npm rebuild` to install .bin links etc.

Notes
=====

* We're currently pretty dumb about already-installed packages. We never remove
or upgrade existing modules. So, restore into an empty `node_modules` to
ensure correct behaviour.

* We look at the installed contents of `node_modules` - we don't check that
they match `packages.json` or that they are in any way clean. In particular,
this will bite if you need native code modules to work on multiple platforms.

* Npm rebuild scripts for some modules do their own downloads. Npmmvn currently
doesn't help with that. The easiest option is to hack the module to download
from somewhere accessible before deploying.

License
=======

Copyright (c) 2013 Jamie Webb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
