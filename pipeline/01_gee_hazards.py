#!/usr/bin/env python3
"""
01_gee_hazards.py – Download and mosaic hazard rasters from Google Earth Engine.

Usage:
    python 01_gee_hazards.py --region tamil_nadu

Outputs:
    data/<region>/hazards.png  (R=flood, G=landslide, B=slope)
    data/<region>/aux.png      (R=population exposure, G=valid-land mask)
    data/<region>/meta.json
"""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path
from datetime import datetime

import ee
import numpy as np
from PIL import Image
import requests
import io

# Add pipeline dir to path for config
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import (
    GEE_PROJECT, REGIONS, GEE_COLLECTIONS, DATE_RANGES,
    FLOOD_WEIGHTS, LANDSLIDE_WEIGHTS, AHP_MATRIX, AHP_CRITERIA, AHP_RI,
    PERCENTILE_CLIP, RISK_CLASSES, DATA_DIR, PIPELINE_TMP
)


def compute_ahp_weights(matrix):
    """Compute AHP weights via principal eigenvector and check consistency."""
    n = matrix.shape[0]
    eigenvalues, eigenvectors = np.linalg.eig(matrix)
    max_idx = np.argmax(eigenvalues.real)
    lambda_max = eigenvalues[max_idx].real
    weights = eigenvectors[:, max_idx].real
    weights = weights / weights.sum()

    ci = (lambda_max - n) / (n - 1)
    ri = AHP_RI.get(n, 1.0)
    cr = ci / ri if ri > 0 else 0

    print(f"  AHP weights: {dict(zip(AHP_CRITERIA, [f'{w:.4f}' for w in weights]))}")
    print(f"  Lambda max: {lambda_max:.4f}, CI: {ci:.4f}, CR: {cr:.4f}")
    assert cr < 0.1, f"AHP consistency ratio {cr:.4f} >= 0.1 – revise the matrix!"
    return weights, lambda_max, ci, cr


def initialize_ee():
    """Initialize Earth Engine with project ID."""
    try:
        ee.Initialize(project=GEE_PROJECT)
        print(f"  GEE initialized with project {GEE_PROJECT}")
    except Exception as e:
        if "credentials" in str(e).lower() or "auth" in str(e).lower() or "not found" in str(e).lower():
            print("\n" + "=" * 60)
            print("EARTH ENGINE AUTHENTICATION REQUIRED")
            print("=" * 60)
            print(f"\nRun this command and follow the prompts:\n")
            print(f"  earthengine authenticate --project={GEE_PROJECT}")
            print(f"\nThen re-run this script.")
            print("=" * 60)
            sys.exit(1)
        raise


def get_state_boundary(region):
    """Get the state boundary from FAO GAUL Level 1."""
    gaul = ee.FeatureCollection(GEE_COLLECTIONS["gaul_level1"])
    state = gaul.filter(ee.Filter.eq("ADM1_NAME", region["gaul_name"]))
    count = state.size().getInfo()
    if count == 0:
        # Try alternate names
        for alt in ["Tamil Nādu", "TAMIL NADU", "Tamilnadu"]:
            state = gaul.filter(ee.Filter.eq("ADM1_NAME", alt))
            count = state.size().getInfo()
            if count > 0:
                print(f"  Found state boundary as '{alt}'")
                break
    if count == 0:
        print("  WARNING: Could not find state in GAUL, using bbox only")
        bbox = region["bbox"]
        return ee.Geometry.Rectangle(bbox), None
    print(f"  Found state boundary: {count} feature(s)")
    return state.geometry(), state


def compute_flood_hazard(region, boundary, bbox_geom):
    """Compute flood hazard composite in GEE."""
    print("  Computing flood hazard factors...")

    # 1. JRC Global Surface Water occurrence
    jrc = ee.Image(GEE_COLLECTIONS["jrc_surface_water"])
    jrc_occurrence = jrc.select("occurrence").divide(100).clamp(0, 1)
    print("    - JRC surface water occurrence")

    # 2. Sentinel-1 VV monsoon water frequency
    s1_col = ee.ImageCollection(GEE_COLLECTIONS["sentinel1"]) \
        .filterBounds(bbox_geom) \
        .filter(ee.Filter.eq("instrumentMode", "IW")) \
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV")) \
        .select("VV")

    water_images = []
    for year in DATE_RANGES["sentinel1_monsoon"]["years"]:
        for season in DATE_RANGES["sentinel1_monsoon"]["seasons"]:
            for month in season["months"]:
                start = f"{year}-{month:02d}-01"
                if month == 12:
                    end = f"{year + 1}-01-01"
                else:
                    end = f"{year}-{month + 1:02d}-01"
                monthly = s1_col.filterDate(start, end)
                # Simple threshold: VV < -15 dB indicates water
                water = monthly.mean().lt(-15).unmask(0)
                water_images.append(water)

    if water_images:
        sar_water_freq = ee.ImageCollection(water_images).mean().clamp(0, 1)
    else:
        sar_water_freq = ee.Image.constant(0)
    print("    - Sentinel-1 monsoon water frequency")

    # 3. CHIRPS 95th percentile daily rainfall
    chirps = ee.ImageCollection(GEE_COLLECTIONS["chirps_daily"]) \
        .filterDate(DATE_RANGES["chirps"]["start"], DATE_RANGES["chirps"]["end"]) \
        .filterBounds(bbox_geom)
    chirps_p95 = chirps.reduce(ee.Reducer.percentile([95])).rename("chirps_p95")
    print("    - CHIRPS 95th percentile rainfall")

    # 4. Relative elevation (elevation - local minimum within 2km)
    srtm = ee.Image(GEE_COLLECTIONS["srtm"]).select("elevation")
    local_min = srtm.reduceNeighborhood(
        reducer=ee.Reducer.min(),
        kernel=ee.Kernel.circle(radius=2000, units="meters")
    )
    rel_elev = srtm.subtract(local_min).clamp(0, 100)
    # Invert: low relative elevation = higher flood hazard
    rel_elev_inv = ee.Image.constant(100).subtract(rel_elev).divide(100).clamp(0, 1)
    print("    - Relative elevation (inverted)")

    # 5. ESA WorldCover built-up/water fraction
    wc = ee.ImageCollection(GEE_COLLECTIONS["esa_worldcover"]).first()
    # Built-up (50) or water (80)
    built_water = wc.eq(50).Or(wc.eq(80)).rename("built_water")
    built_water_frac = built_water.reduceNeighborhood(
        reducer=ee.Reducer.mean(),
        kernel=ee.Kernel.circle(radius=1000, units="meters")
    ).clamp(0, 1)
    print("    - ESA WorldCover built-up/water fraction")

    # Combine with weights
    flood = jrc_occurrence.multiply(FLOOD_WEIGHTS["jrc_occurrence"]) \
        .add(sar_water_freq.multiply(FLOOD_WEIGHTS["sar_water_freq"])) \
        .add(chirps_p95.divide(200).clamp(0, 1).multiply(FLOOD_WEIGHTS["chirps_heavy_rain"])) \
        .add(rel_elev_inv.multiply(FLOOD_WEIGHTS["relative_elevation"])) \
        .add(built_water_frac.multiply(FLOOD_WEIGHTS["built_water_fraction"]))

    return flood.rename("flood_hazard")


def compute_landslide_hazard(region, boundary, bbox_geom):
    """Compute landslide hazard composite in GEE."""
    print("  Computing landslide hazard factors...")

    # 1. Slope from SRTM
    srtm = ee.Image(GEE_COLLECTIONS["srtm"]).select("elevation")
    slope = ee.Terrain.slope(srtm)
    slope_norm = slope.divide(60).clamp(0, 1)  # 60 degrees as practical max
    print("    - Slope from SRTM")

    # 2. CHIRPS heavy rain percentile (reuse)
    chirps = ee.ImageCollection(GEE_COLLECTIONS["chirps_daily"]) \
        .filterDate(DATE_RANGES["chirps"]["start"], DATE_RANGES["chirps"]["end"]) \
        .filterBounds(bbox_geom)
    chirps_p95 = chirps.reduce(ee.Reducer.percentile([95])).rename("chirps_p95")
    chirps_norm = chirps_p95.divide(200).clamp(0, 1)
    print("    - CHIRPS heavy-rain percentile")

    # 3. ESA WorldCover land cover vulnerability
    wc = ee.ImageCollection(GEE_COLLECTIONS["esa_worldcover"]).first()
    # Vulnerability: bare=1.0, cropland=0.7, grassland=0.5, shrub=0.4, tree=0.1, built=0.3, water=0
    lc_vuln = wc \
        .where(wc.eq(10), 0.1) \
        .where(wc.eq(20), 0.4) \
        .where(wc.eq(30), 0.5) \
        .where(wc.eq(40), 0.7) \
        .where(wc.eq(50), 0.3) \
        .where(wc.eq(60), 1.0) \
        .where(wc.eq(80), 0.0) \
        .where(wc.eq(90), 0.2) \
        .where(wc.eq(95), 0.0) \
        .where(wc.eq(100), 0.0) \
        .divide(100).clamp(0, 1)
    # Actually WorldCover values are class codes, we want to remap:
    lc_vuln = wc.remap(
        [10, 20, 30, 40, 50, 60, 80, 90, 95, 100],
        [10, 40, 50, 70, 30, 100, 0, 20, 0, 0]
    ).divide(100).clamp(0, 1).rename("lc_vuln")
    print("    - Land cover vulnerability")

    # 4. MODIS NDVI inverse
    ndvi = ee.ImageCollection(GEE_COLLECTIONS["modis_ndvi"]) \
        .filterDate(DATE_RANGES["modis_ndvi"]["start"], DATE_RANGES["modis_ndvi"]["end"]) \
        .filterBounds(bbox_geom) \
        .select("NDVI")
    ndvi_mean = ndvi.mean().multiply(0.0001).clamp(0, 1)  # MODIS NDVI scale factor
    ndvi_inv = ee.Image.constant(1).subtract(ndvi_mean).clamp(0, 1)
    print("    - MODIS NDVI (inverse)")

    # Combine
    landslide = slope_norm.multiply(LANDSLIDE_WEIGHTS["slope"]) \
        .add(chirps_norm.multiply(LANDSLIDE_WEIGHTS["chirps_heavy_rain"])) \
        .add(lc_vuln.multiply(LANDSLIDE_WEIGHTS["landcover_vulnerability"])) \
        .add(ndvi_inv.multiply(LANDSLIDE_WEIGHTS["ndvi_inverse"]))

    return landslide.rename("landslide_hazard"), slope.rename("slope_deg")


def compute_population_exposure(region, boundary, bbox_geom):
    """Compute population exposure layer."""
    print("  Computing population exposure...")

    # Try GHSL first, then WorldPop
    try:
        pop = ee.ImageCollection(GEE_COLLECTIONS["ghsl_pop"]) \
            .filterBounds(bbox_geom) \
            .sort("system:time_start", False) \
            .first() \
            .select("population_count")
        test = pop.bandNames().getInfo()
        print("    - Using GHSL Population Grid")
    except Exception:
        print("    - GHSL not available, trying WorldPop...")
        pop = ee.ImageCollection(GEE_COLLECTIONS["worldpop"]) \
            .filterBounds(bbox_geom) \
            .sort("system:time_start", False) \
            .first() \
            .select("population")
        print("    - Using WorldPop")

    return pop.rename("population")


def normalize_minmax_ee(image, bbox_geom, scale):
    """Compute 2nd/98th percentile for normalization."""
    stats = image.reduceRegion(
        reducer=ee.Reducer.percentile([2, 98]),
        geometry=bbox_geom,
        scale=scale * 4,  # coarser for speed
        maxPixels=1e8,
        bestEffort=True
    )
    return stats.getInfo()


def download_tile(image, bbox, scale, crs, bands, max_retries=3):
    """Download a single tile using getDownloadURL."""
    region = ee.Geometry.Rectangle(bbox)
    for attempt in range(max_retries):
        try:
            current_scale = scale if attempt == 0 else scale * 2
            url = image.select(bands).getDownloadURL({
                'region': region,
                'scale': current_scale,
                'crs': crs,
                'format': 'NPY',
            })
            response = requests.get(url, timeout=120)
            response.raise_for_status()
            data = np.load(io.BytesIO(response.content), allow_pickle=True)
            return data, current_scale
        except Exception as e:
            print(f"      Tile {bbox} attempt {attempt + 1} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(5 * (attempt + 1))
            else:
                print(f"      SKIPPING tile {bbox} after {max_retries} attempts")
                return None, scale
    return None, scale


def download_and_mosaic(image, region_cfg, band_name, description="layer"):
    """Download image as 1x1 degree tiles and mosaic with numpy."""
    bbox = region_cfg["bbox"]
    scale = region_cfg["scale_m"]
    crs = region_cfg["output_crs"]
    tile_deg = region_cfg["tile_deg"]

    west, south, east, north = bbox
    tiles_x = math.ceil((east - west) / tile_deg)
    tiles_y = math.ceil((north - south) / tile_deg)
    total_tiles = tiles_x * tiles_y
    print(f"  Downloading {description}: {tiles_x}x{tiles_y} = {total_tiles} tiles at {scale}m")

    all_data = []
    tile_scales = []
    tile_bboxes = []

    for iy in range(tiles_y - 1, -1, -1):  # top to bottom
        row_data = []
        for ix in range(tiles_x):
            tile_bbox = [
                west + ix * tile_deg,
                south + iy * tile_deg,
                min(west + (ix + 1) * tile_deg, east),
                min(south + (iy + 1) * tile_deg, north)
            ]
            tile_num = (tiles_y - 1 - iy) * tiles_x + ix + 1
            print(f"    Tile {tile_num}/{total_tiles}: {tile_bbox}")

            data, actual_scale = download_tile(
                image, tile_bbox, scale, crs, [band_name]
            )
            if data is not None:
                # NPY from EE is a structured array
                if data.dtype.names:
                    arr = data[band_name].astype(np.float32)
                else:
                    arr = data.astype(np.float32)
                row_data.append(arr)
                tile_scales.append(actual_scale)
            else:
                row_data.append(None)
            tile_bboxes.append(tile_bbox)

        all_data.append(row_data)

    # Find common dimensions for each tile position and mosaic
    # First pass: find max dimensions per row/column
    row_heights = []
    col_widths = [0] * tiles_x
    for iy, row in enumerate(all_data):
        max_h = 0
        for ix, tile in enumerate(row):
            if tile is not None:
                max_h = max(max_h, tile.shape[0])
                col_widths[ix] = max(col_widths[ix], tile.shape[1])
        row_heights.append(max_h if max_h > 0 else 1)

    # Assemble mosaic
    total_h = sum(row_heights)
    total_w = sum(col_widths)
    mosaic = np.full((total_h, total_w), np.nan, dtype=np.float32)

    y_off = 0
    for iy, row in enumerate(all_data):
        x_off = 0
        for ix, tile in enumerate(row):
            if tile is not None:
                h, w = tile.shape
                mosaic[y_off:y_off + h, x_off:x_off + w] = tile
            x_off += col_widths[ix]
        y_off += row_heights[iy]

    print(f"  Mosaic shape: {mosaic.shape}, range: [{np.nanmin(mosaic):.3f}, {np.nanmax(mosaic):.3f}]")
    return mosaic


def download_multiband(image, region_cfg, band_names, description="layer"):
    """Download multi-band image and return dict of arrays."""
    bbox = region_cfg["bbox"]
    scale = region_cfg["scale_m"]
    crs = region_cfg["output_crs"]
    tile_deg = region_cfg["tile_deg"]

    west, south, east, north = bbox
    tiles_x = math.ceil((east - west) / tile_deg)
    tiles_y = math.ceil((north - south) / tile_deg)
    total_tiles = tiles_x * tiles_y
    print(f"  Downloading {description}: {tiles_x}x{tiles_y} = {total_tiles} tiles, bands={band_names}")

    # Collect tiles per band
    band_tiles = {b: [] for b in band_names}

    for iy in range(tiles_y - 1, -1, -1):
        band_row = {b: [] for b in band_names}
        for ix in range(tiles_x):
            tile_bbox = [
                west + ix * tile_deg,
                south + iy * tile_deg,
                min(west + (ix + 1) * tile_deg, east),
                min(south + (iy + 1) * tile_deg, north)
            ]
            tile_num = (tiles_y - 1 - iy) * tiles_x + ix + 1
            print(f"    Tile {tile_num}/{total_tiles}: {tile_bbox}")

            region_geom = ee.Geometry.Rectangle(tile_bbox)
            for attempt in range(3):
                try:
                    current_scale = scale if attempt == 0 else scale * 2
                    url = image.select(band_names).getDownloadURL({
                        'region': region_geom,
                        'scale': current_scale,
                        'crs': crs,
                        'format': 'NPY',
                    })
                    response = requests.get(url, timeout=180)
                    response.raise_for_status()
                    data = np.load(io.BytesIO(response.content), allow_pickle=True)

                    for b in band_names:
                        if data.dtype.names and b in data.dtype.names:
                            arr = data[b].astype(np.float32)
                        elif data.dtype.names:
                            # try first band
                            arr = data[data.dtype.names[0]].astype(np.float32)
                        else:
                            arr = data.astype(np.float32)
                        band_row[b].append(arr)
                    break
                except Exception as e:
                    print(f"      Attempt {attempt + 1} failed: {e}")
                    if attempt < 2:
                        time.sleep(5 * (attempt + 1))
                    else:
                        for b in band_names:
                            band_row[b].append(None)

        for b in band_names:
            band_tiles[b].append(band_row[b])

    # Mosaic each band
    results = {}
    for b in band_names:
        tiles = band_tiles[b]
        # Find dimensions
        row_heights = []
        col_widths = [0] * tiles_x
        for row in tiles:
            max_h = 0
            for ix, tile in enumerate(row):
                if tile is not None:
                    max_h = max(max_h, tile.shape[0])
                    col_widths[ix] = max(col_widths[ix], tile.shape[1])
            row_heights.append(max_h if max_h > 0 else 1)

        total_h = sum(row_heights)
        total_w = sum(col_widths)
        mosaic = np.full((total_h, total_w), np.nan, dtype=np.float32)

        y_off = 0
        for iy_idx, row in enumerate(tiles):
            x_off = 0
            for ix_idx, tile in enumerate(row):
                if tile is not None:
                    h, w = tile.shape
                    mosaic[y_off:y_off + h, x_off:x_off + w] = tile
                x_off += col_widths[ix_idx]
            y_off += row_heights[iy_idx]

        results[b] = mosaic
        print(f"  Band '{b}' mosaic: {mosaic.shape}, range: [{np.nanmin(mosaic):.3f}, {np.nanmax(mosaic):.3f}]")

    return results


def normalize_array(arr, p_low=2, p_high=98):
    """Min-max normalize with percentile clipping. Returns normalized array and (min, max)."""
    valid = arr[~np.isnan(arr)]
    if len(valid) == 0:
        return np.zeros_like(arr), (0, 1)
    vmin = np.percentile(valid, p_low)
    vmax = np.percentile(valid, p_high)
    if vmax <= vmin:
        vmax = vmin + 1
    normalized = np.clip((arr - vmin) / (vmax - vmin), 0, 1)
    normalized = np.where(np.isnan(arr), 0, normalized)
    return normalized, (float(vmin), float(vmax))


def main():
    parser = argparse.ArgumentParser(description="Download hazard rasters from GEE")
    parser.add_argument("--region", required=True, help="Region ID (e.g., tamil_nadu)")
    args = parser.parse_args()

    region_id = args.region
    if region_id not in REGIONS:
        print(f"Unknown region: {region_id}. Available: {list(REGIONS.keys())}")
        sys.exit(1)
    region = REGIONS[region_id]
    print(f"\n{'='*60}")
    print(f"PHASE 1: GEE Hazard Pipeline – {region['name']}")
    print(f"{'='*60}\n")

    # Compute AHP weights
    print("Step 0: AHP weights")
    ahp_weights, lambda_max, ci, cr = compute_ahp_weights(AHP_MATRIX)
    weight_dict = dict(zip(AHP_CRITERIA, ahp_weights.tolist()))

    # Initialize EE
    print("\nStep 1: Initialize Earth Engine")
    initialize_ee()

    # Get state boundary
    print("\nStep 2: Get state boundary")
    bbox = region["bbox"]
    bbox_geom = ee.Geometry.Rectangle(bbox)
    boundary, state_fc = get_state_boundary(region)

    # Create mask
    if state_fc is not None:
        mask = ee.Image.constant(1).clip(state_fc).unmask(0)
    else:
        mask = ee.Image.constant(1)

    # Compute hazard layers
    print("\nStep 3: Compute flood hazard")
    flood = compute_flood_hazard(region, boundary, bbox_geom)
    flood = flood.updateMask(mask).unmask(0)

    print("\nStep 4: Compute landslide hazard & slope")
    landslide, slope = compute_landslide_hazard(region, boundary, bbox_geom)
    landslide = landslide.updateMask(mask).unmask(0)
    slope = slope.updateMask(mask).unmask(0)

    print("\nStep 5: Compute population exposure")
    pop = compute_population_exposure(region, boundary, bbox_geom)
    pop = pop.updateMask(mask).unmask(0)

    # Create the composite multi-band image
    composite = flood.addBands(landslide).addBands(slope).addBands(pop)
    band_names = ["flood_hazard", "landslide_hazard", "slope_deg", "population"]

    # Download
    print("\nStep 6: Download rasters")
    os.makedirs(PIPELINE_TMP, exist_ok=True)

    bands = download_multiband(composite, region, band_names, "hazard composite")

    flood_arr = bands["flood_hazard"]
    landslide_arr = bands["landslide_hazard"]
    slope_arr = bands["slope_deg"]
    pop_arr = bands["population"]

    # Normalize
    print("\nStep 7: Normalize layers")
    flood_norm, flood_range = normalize_array(flood_arr)
    landslide_norm, landslide_range = normalize_array(landslide_arr)
    slope_norm, slope_range = normalize_array(slope_arr)
    pop_norm, pop_range = normalize_array(pop_arr)

    print(f"  Flood range: {flood_range}")
    print(f"  Landslide range: {landslide_range}")
    print(f"  Slope range: {slope_range}")
    print(f"  Population range: {pop_range}")

    # Create land mask (where any layer has data)
    land_mask = (~np.isnan(bands["flood_hazard"])) | (~np.isnan(bands["landslide_hazard"]))
    # Also mask where all values are essentially zero (ocean/outside)
    all_near_zero = (np.abs(flood_arr) < 0.001) & (np.abs(landslide_arr) < 0.001) & (np.abs(pop_arr) < 0.01)
    # Keep areas that have at least some signal
    land_mask = land_mask & (~all_near_zero | (np.abs(slope_arr) > 0.1))

    # Write hazards.png (R=flood, G=landslide, B=slope)
    print("\nStep 8: Write output PNGs")
    out_dir = os.path.join(DATA_DIR, region_id)
    os.makedirs(out_dir, exist_ok=True)

    h, w = flood_norm.shape
    hazards_rgba = np.zeros((h, w, 4), dtype=np.uint8)
    hazards_rgba[:, :, 0] = (flood_norm * 255).astype(np.uint8)
    hazards_rgba[:, :, 1] = (landslide_norm * 255).astype(np.uint8)
    hazards_rgba[:, :, 2] = (slope_norm * 255).astype(np.uint8)
    hazards_rgba[:, :, 3] = 255  # Full alpha everywhere

    hazards_path = os.path.join(out_dir, "hazards.png")
    Image.fromarray(hazards_rgba, "RGBA").save(hazards_path, optimize=True)
    hazards_size = os.path.getsize(hazards_path)
    print(f"  hazards.png: {w}x{h}, {hazards_size / 1024 / 1024:.1f} MB")

    # Write aux.png (R=population exposure, G=land mask)
    aux_rgba = np.zeros((h, w, 4), dtype=np.uint8)
    aux_rgba[:, :, 0] = (pop_norm * 255).astype(np.uint8)
    aux_rgba[:, :, 1] = (land_mask.astype(np.uint8) * 255)
    aux_rgba[:, :, 2] = 0
    aux_rgba[:, :, 3] = 255

    aux_path = os.path.join(out_dir, "aux.png")
    Image.fromarray(aux_rgba, "RGBA").save(aux_path, optimize=True)
    aux_size = os.path.getsize(aux_path)
    print(f"  aux.png: {w}x{h}, {aux_size / 1024 / 1024:.1f} MB")

    # Write meta.json
    print("\nStep 9: Write meta.json")
    meta = {
        "region_id": region_id,
        "region_name": region["name"],
        "bbox": bbox,
        "crs": region["output_crs"],
        "pixel_size_m": region["scale_m"],
        "raster_width": w,
        "raster_height": h,
        "date_ranges": {
            "sentinel1": DATE_RANGES["sentinel1_monsoon"],
            "chirps": DATE_RANGES["chirps"],
            "modis_ndvi": DATE_RANGES["modis_ndvi"],
            "worldcover": DATE_RANGES["worldcover"],
            "population": DATE_RANGES["ghsl_pop"],
        },
        "sources": {k: v for k, v in GEE_COLLECTIONS.items()},
        "normalization": {
            "method": "min-max with 2nd/98th percentile clipping",
            "flood": {"min": flood_range[0], "max": flood_range[1]},
            "landslide": {"min": landslide_range[0], "max": landslide_range[1]},
            "slope_deg": {"min": slope_range[0], "max": slope_range[1]},
            "population": {"min": pop_range[0], "max": pop_range[1]},
        },
        "hazards_png": {
            "R": "flood_hazard (normalized 0-255)",
            "G": "landslide_hazard (normalized 0-255)",
            "B": "slope_deg (normalized 0-255)",
            "A": "255 (constant, do not use)"
        },
        "aux_png": {
            "R": "population_exposure (normalized 0-255)",
            "G": "valid_land_mask (255=land, 0=sea/outside)",
            "B": "unused",
            "A": "255 (constant)"
        },
        "flood_factors": FLOOD_WEIGHTS,
        "landslide_factors": LANDSLIDE_WEIGHTS,
        "ahp": {
            "criteria": AHP_CRITERIA,
            "matrix": AHP_MATRIX.tolist(),
            "weights": weight_dict,
            "lambda_max": float(lambda_max),
            "ci": float(ci),
            "cr": float(cr),
        },
        "risk_classes": RISK_CLASSES,
        "build_time": datetime.now().isoformat(),
        "limitations": [
            f"Spatial resolution: {region['scale_m']}m",
            "OSM road/facility data may be incomplete in rural areas",
            "Shelters approximated from OSM emergency/community facilities",
            "Not an official hazard assessment – for research/hackathon use",
            "GAUL district boundaries may not match latest admin boundaries",
            "Sentinel-1 water detection uses simple VV threshold, not a calibrated model",
        ]
    }
    meta_path = os.path.join(out_dir, "meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"  meta.json written")

    # Summary
    print(f"\n{'='*60}")
    print("PIPELINE COMPLETE")
    print(f"{'='*60}")
    print(f"  hazards.png: {w}x{h} px, {hazards_size/1024/1024:.1f} MB")
    print(f"  aux.png:     {w}x{h} px, {aux_size/1024/1024:.1f} MB")
    print(f"  meta.json:   {os.path.getsize(meta_path)} bytes")
    print(f"  Output dir:  {out_dir}")
    print(f"\nAHP weights: {weight_dict}")
    print(f"CR = {cr:.4f} (< 0.1 ✓)")


if __name__ == "__main__":
    main()
