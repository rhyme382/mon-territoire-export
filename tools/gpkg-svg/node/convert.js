import { convertGeoPackage } from '../core/pipeline.js';
import { openGeoPackage } from './sqlite-reader.js';

export { CONVERTER_SCHEMA, GENERATOR } from '../core/pipeline.js';

export function convertGeoPackageToSvg(inputPath, options = {}) {
  const gpkg = openGeoPackage(inputPath);
  try {
    return convertGeoPackage(gpkg, options);
  } finally {
    gpkg.close();
  }
}
