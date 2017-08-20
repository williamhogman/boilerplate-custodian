#!/usr/bin/env node

const fs = require('mz/fs')
const fse = require('fs-extra')
const edn = require('jsedn')
const path = require('path')
const handlebars = require('handlebars')

const CUSTODIAN_FILE = "Custodianfile"


const absolutizePath = (root, rel) => path.normalize(`${root}/${rel}`)


async function applyStep(srcRoot, destRoot, step, context) {
  if (step.type[0] === 'x' && (await fs.exists(absolutizePath(destRoot, step.dest)))) {
    console.log(`SKIP\t${step.dest}`)
    return null
  }
  if (step.type === "copy" || step.type == "xcopy") {
    fse.copy(absolutizePath(srcRoot, step.src), absolutizePath(destRoot, step.dest))
    console.log(`COPY\t${step.src}\t${step.dest}`)
  } else if (step.type === "template" || step.type === "xtemplate") {
    const templateBfr = await fs.readFile(absolutizePath(srcRoot, step.src))
    const template = handlebars.compile(templateBfr.toString(), { noEscape: true })
    const result = template(context)
    const dest = absolutizePath(destRoot, step.dest)
    console.log(`TEMPLATE\t${step.src}\t${step.dest}`)
    await fs.writeFile(dest, result)
  } else if (step.type == "from") {
    console.log(`FROM\t${step.tag}`)
    return { from: step.tag }
  } else if(step.type == "arg") {
    return { arg: { [step.name]: step.value }}
  } else {
    throw new Error('Invalid step ' + JSON.stringify(step))
  }
  return null
}

async function applyCustodianFile(srcRoot, destRoot, steps, tags, initialContext) {
  let context = initialContext
  for (let step of steps) {
    const specialAction = await applyStep(srcRoot, destRoot, step, context)
    if (specialAction) {
      if (specialAction.from) {
        const importedFile = tags[specialAction.from]
        // When recuring remove the called file to prevent loops
        const newTags = Object.assign(tags, { [specialAction.from]: undefined })

        context = await applyCustodianFile(importedFile.root, destRoot, importedFile.steps, newTags, context)
      }
      if (specialAction.arg) {
        context = Object.assign({}, specialAction.arg, context)
      }
    }
  }
  return context
}

function formatStep(step) {
  const type = step[0].toLowerCase()
  if (type === 'template'
      || type === 'copy'
      || type === "xtemplate"
      || type === "xcopy") {
    return { type, src: step[1], dest: step[2] || step[1] }
  } else if (type === 'arg') {
    return { type, name: step[1], value: step[2] || step[3] }
  } else if (type === 'from') {
    return { type, tag: step[1] }
  } else {
    throw new Error('Unknown command ' + step)
  }
}

function parseCustodianFile(data, root) {
  const parsed = edn.toJS(edn.parse(data.toString()))
  const steps = parsed[':steps']
  const name = parsed[':name']
  const noDest = !!parsed[':nodest']
  if (!Array.isArray(steps)) {
    throw new Error('Custodianfile must have an array of steps')
  }
  return { [name]: { steps: steps.map(formatStep), name: name || root, root, noDest } }
}

async function readCustodianFile(root) {
  const p = `${root}/${CUSTODIAN_FILE}`
  if (await fs.exists(p)) {
    const data = await fs.readFile(p)
    return parseCustodianFile(data, path.normalize(root))
  } else {
    console.log("No Custodianfile found at", root)
    return {}
  }
}

async function main(imports, dest) {
  const toCombine = await Promise.all(imports.map(readCustodianFile))
  const tags = toCombine.reduce((acc, x) => Object.assign({}, x, acc), {})
  const destCust = await readCustodianFile(dest)

  const destCustKey = Object.keys(destCust)[0]
  if (!destCustKey) {
    console.log("Nothing to do here...")
    return
  }

  const destC = destCust[destCustKey]

  if (destC.noDest) {
    console.log("The specified destination has the `nodest` pragma. Stopping.")
    return
  }

  applyCustodianFile(dest, dest, destC.steps, tags, {})
}

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  // application specific logging, throwing an error, or other logic here
})

const args = process.argv.slice(2)

const tags = args.slice(0, -1)
const dest = args[args.length - 1]

if (dest) {
  main(tags, dest)
} else {
  console.log("Need at least one input")
}
