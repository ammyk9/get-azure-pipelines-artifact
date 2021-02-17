import fs from 'fs'
import https from 'https'
import {Readable} from 'stream'
import unzipper from 'unzipper'
import {spawn} from 'child_process'
import {delimiter} from 'path'

async function fetchJSONFromURL<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    https
      .request(url, {}, res => {
        if (res.statusCode !== 200) {
          reject(
            new Error(
              `Got code ${res.statusCode}, URL: ${url}, message: ${res.statusMessage}`
            )
          )
          return
        }
        const data: Uint8Array[] = []
        res
          .on('data', (chunk: Uint8Array) => data.push(chunk))
          .on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(data).toString('utf-8')))
            } catch (e) {
              reject(e)
            }
          })
          .on('error', e => reject(e))
      })
      .on('error', e => reject(e))
      .end()
  })
}

function mkdirp(directoryPath: string): void {
  try {
    const stat = fs.statSync(directoryPath)
    if (stat.isDirectory()) {
      return
    }
    throw new Error(`${directoryPath} exists, but is not a directory`)
  } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      throw e
    }
  }
  fs.mkdirSync(directoryPath, {recursive: true})
}

async function unzip(
  url: string,
  stripPrefix: string,
  outputDirectory: string,
  verbose: boolean | number,
  streamEntries?: (
    path: string,
    stream: Readable,
    directory: string,
    _verbose: boolean | number
  ) => void
): Promise<void> {
  let progress =
    verbose === false
      ? (): void => {}
      : (path: string): void => {
          path === undefined || process.stderr.write(`${path}\n`)
        }
  if (typeof verbose === 'number') {
    let counter = 0
    progress = (path?: string): void => {
      if (path === undefined || ++counter % verbose === 0) {
        process.stderr.write(`${counter} items extracted\n`)
      }
    }
  }
  mkdirp(outputDirectory)
  return new Promise<void>((resolve, reject) => {
    const handleStream = (res: Readable): void => {
      res
        .pipe(unzipper.Parse())
        .on('entry', entry => {
          if (streamEntries) {
            streamEntries(entry.path, entry, outputDirectory, verbose)
            return
          }
          if (!entry.path.startsWith(stripPrefix)) {
            process.stderr.write(
              `warning: skipping ${entry.path} because it does not start with ${stripPrefix}\n`
            )
          }
          const entryPath = `${outputDirectory}/${entry.path.substring(
            stripPrefix.length
          )}`
          progress(entryPath)
          if (entryPath.endsWith('/')) {
            mkdirp(entryPath.replace(/\/$/, ''))
            entry.autodrain()
          } else {
            entry.pipe(fs.createWriteStream(`${entryPath}`))
          }
        })
        .on('error', reject)
        .on('finish', progress)
        .on('finish', resolve)
    }

    if (!streamEntries) {
      https.get(url, handleStream)
    } else {
      // `https.get()` seems to have performance problems that cause frequent
      // ECONNRESET problems with larger payloads. Let's (ab-)use Git for Windows'
      // `curl.exe` to do the downloading for us in that case.
      const curl = spawn('C:/Program Files/Git/mingw64/bin/curl.exe', [url])
      handleStream(curl.stdout)
      // eslint-disable-next-line no-console
      curl.stderr.on('data', chunk => console.log(`${chunk}`))
    }
  })
}

/* We're (ab-)using Git for Windows' `tar.exe` and `xz.exe` to do the job */
function unpackTarXZEntry(
  path: string,
  stream: Readable,
  outputDirectory: string,
  verbose: boolean | number = false
): void {
  if (path.endsWith('/')) return
  if (!path.endsWith('.tar.xz')) {
    process.stderr.write(`warning: unhandled entry: ${path}`)
    return
  }

  const usrBinPath = 'C:/Program Files/Git/usr/bin'
  const tarXZ = spawn(
    `${usrBinPath}/tar.exe`,
    [verbose === true ? 'xJvf' : 'xJf', '-'],
    {
      cwd: outputDirectory,
      env: {
        PATH: `${usrBinPath}${delimiter}${process.env.PATH}`
      },
      stdio: ['pipe', 'inherit', 'inherit']
    }
  )
  stream.pipe(tarXZ.stdin)
}

export async function get(
  flavor: string,
  architecture: string
): Promise<{
  id: string
  download: (
    outputDirectory: string,
    verbose?: number | boolean
  ) => Promise<void>
}> {
  if (!['x86_64', 'i686'].includes(architecture)) {
    throw new Error(`Unsupported architecture: ${architecture}`)
  }

  let definitionId: number
  let artifactName: string
  switch (flavor) {
    case 'minimal':
      if (architecture === 'i686') {
        throw new Error(`Flavor "minimal" is only available for x86_64`)
      }
      definitionId = 22
      artifactName = 'git-sdk-64-minimal'
      break
    case 'makepkg-git':
      if (architecture === 'i686') {
        throw new Error(`Flavor "makepkg-git" is only available for x86_64`)
      }
      definitionId = 29
      artifactName = 'git-sdk-64-makepkg-git'
      break
    case 'build-installers':
    case 'full':
      definitionId = architecture === 'i686' ? 30 : 29
      artifactName = `git-sdk-${architecture === 'i686' ? 32 : 64}-${
        flavor === 'full' ? 'full-sdk' : flavor
      }`
      break
    default:
      throw new Error(`Unknown flavor: '${flavor}`)
  }

  const baseURL = 'https://dev.azure.com/git-for-windows/git/_apis/build/builds'
  const data = await fetchJSONFromURL<{
    count: number
    value: [{id: string; downloadURL: string}]
  }>(
    `${baseURL}?definitions=${definitionId}&statusFilter=completed&resultFilter=succeeded&$top=1`
  )
  if (data.count !== 1) {
    throw new Error(`Unexpected number of builds: ${data.count}`)
  }
  const id = `${artifactName}-${data.value[0].id}`
  const download = async (
    outputDirectory: string,
    verbose: number | boolean = false
  ): Promise<void> => {
    const data2 = await fetchJSONFromURL<{
      count: number
      value: [{name: string; resource: {downloadUrl: string}}]
    }>(`${baseURL}/${data.value[0].id}/artifacts`)
    const filtered = data2.value.filter(e => e.name === artifactName)
    if (filtered.length !== 1) {
      throw new Error(
        `Could not find ${artifactName} in ${JSON.stringify(data2, null, 4)}`
      )
    }
    const url = filtered[0].resource.downloadUrl
    await unzip(
      url,
      `${artifactName}/`,
      outputDirectory,
      verbose,
      flavor === 'full' ? unpackTarXZEntry : undefined
    )
  }
  return {download, id}
}