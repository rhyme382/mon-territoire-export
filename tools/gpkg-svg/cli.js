#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GpkgSvgError } from './core/errors.js';
import { convertGeoPackageToSvg } from './node/convert.js';

const USAGE = 'Usage: npm run gpkg-to-svg -- --input <fichier.gpkg> --output <fichier.svg> [--layer <nom>] [--width <px>] [--padding <px>]';

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      layer: { type: 'string' },
      width: { type: 'string', default: '1200' },
      padding: { type: 'string', default: '20' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.input || !values.output) throw new GpkgSvgError('BAD_OPTION', `--input et --output sont requis.\n${USAGE}`);
  const width = Number(values.width);
  const padding = Number(values.padding);
  const { svg, summary } = convertGeoPackageToSvg(values.input, { layer: values.layer, width, padding });
  writeFileSync(values.output, svg, 'utf8');
  console.log(`layer: ${summary.layer}`);
  console.log(`geometry: ${summary.geometry}`);
  console.log(`features: ${summary.features}`);
  if (summary.skipped) console.log(`skipped (empty geometry): ${summary.skipped}`);
  console.log(`crs: ${summary.crs}`);
  console.log(`output: ${values.output}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const known = error instanceof GpkgSvgError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || error?.code?.startsWith?.('ERR_PARSE_ARGS');
  console.error(`Erreur : ${known ? error.message : 'échec inattendu de la conversion.'}`);
  process.exitCode = 1;
}
