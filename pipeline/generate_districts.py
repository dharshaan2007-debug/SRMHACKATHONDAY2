#!/usr/bin/env python3
"""
Generate simplified district GeoJSON for Tamil Nadu from hazard rasters.
Uses rough district bounding boxes since we can't access GEE.
"""

import json
import os
import numpy as np
from PIL import Image

# Tamil Nadu districts with approximate centroids and bounding boxes
DISTRICTS = [
    {"name": "Chennai", "lat": 13.08, "lon": 80.27, "bbox": [80.05, 12.85, 80.35, 13.25]},
    {"name": "Coimbatore", "lat": 11.02, "lon": 76.96, "bbox": [76.65, 10.75, 77.25, 11.35]},
    {"name": "Madurai", "lat": 9.93, "lon": 78.12, "bbox": [77.75, 9.65, 78.55, 10.20]},
    {"name": "Tiruchirappalli", "lat": 10.79, "lon": 78.69, "bbox": [78.30, 10.50, 79.10, 11.10]},
    {"name": "Salem", "lat": 11.66, "lon": 78.16, "bbox": [77.70, 11.35, 78.60, 12.00]},
    {"name": "Tirunelveli", "lat": 8.73, "lon": 77.69, "bbox": [77.20, 8.35, 78.15, 9.10]},
    {"name": "Erode", "lat": 11.34, "lon": 77.73, "bbox": [77.30, 11.05, 78.15, 11.65]},
    {"name": "Vellore", "lat": 12.92, "lon": 79.13, "bbox": [78.65, 12.60, 79.60, 13.25]},
    {"name": "Thanjavur", "lat": 10.77, "lon": 79.14, "bbox": [78.75, 10.45, 79.55, 11.05]},
    {"name": "Kanchipuram", "lat": 12.83, "lon": 79.70, "bbox": [79.40, 12.55, 80.10, 13.10]},
    {"name": "Cuddalore", "lat": 11.75, "lon": 79.77, "bbox": [79.35, 11.40, 80.05, 12.10]},
    {"name": "Dindigul", "lat": 10.36, "lon": 77.97, "bbox": [77.55, 10.05, 78.40, 10.65]},
    {"name": "Villupuram", "lat": 11.94, "lon": 79.50, "bbox": [79.05, 11.65, 79.95, 12.25]},
    {"name": "Tiruvannamalai", "lat": 12.23, "lon": 79.07, "bbox": [78.65, 11.90, 79.50, 12.55]},
    {"name": "Nagapattinam", "lat": 10.76, "lon": 79.84, "bbox": [79.45, 10.35, 80.10, 11.10]},
    {"name": "Thoothukudi", "lat": 8.78, "lon": 78.13, "bbox": [77.70, 8.40, 78.55, 9.15]},
    {"name": "Ramanathapuram", "lat": 9.38, "lon": 78.83, "bbox": [78.40, 9.10, 79.45, 9.65]},
    {"name": "Nilgiris", "lat": 11.41, "lon": 76.70, "bbox": [76.35, 11.15, 77.10, 11.65]},
    {"name": "Kanyakumari", "lat": 8.18, "lon": 77.41, "bbox": [77.05, 8.05, 77.80, 8.40]},
    {"name": "Sivagangai", "lat": 10.04, "lon": 78.60, "bbox": [78.25, 9.75, 79.00, 10.35]},
    {"name": "Dharmapuri", "lat": 12.13, "lon": 78.16, "bbox": [77.70, 11.80, 78.55, 12.45]},
    {"name": "Krishnagiri", "lat": 12.52, "lon": 78.21, "bbox": [77.80, 12.20, 78.65, 12.80]},
    {"name": "Virudhunagar", "lat": 9.59, "lon": 77.96, "bbox": [77.55, 9.30, 78.35, 9.90]},
    {"name": "Tiruppur", "lat": 11.11, "lon": 77.35, "bbox": [76.95, 10.80, 77.75, 11.40]},
    {"name": "Namakkal", "lat": 11.22, "lon": 78.17, "bbox": [77.80, 10.95, 78.55, 11.50]},
    {"name": "Karur", "lat": 10.96, "lon": 78.08, "bbox": [77.70, 10.70, 78.45, 11.20]},
    {"name": "Perambalur", "lat": 11.23, "lon": 78.88, "bbox": [78.55, 11.00, 79.20, 11.45]},
    {"name": "Ariyalur", "lat": 11.14, "lon": 79.08, "bbox": [78.75, 10.90, 79.40, 11.40]},
    {"name": "Pudukkottai", "lat": 10.38, "lon": 78.82, "bbox": [78.45, 10.10, 79.20, 10.65]},
    {"name": "Theni", "lat": 10.00, "lon": 77.48, "bbox": [77.10, 9.70, 77.85, 10.30]},
    {"name": "Tirupur", "lat": 11.11, "lon": 77.35, "bbox": [76.95, 10.80, 77.75, 11.40]},
]

# Remove duplicates
seen = set()
unique_districts = []
for d in DISTRICTS:
    if d["name"] not in seen:
        seen.add(d["name"])
        unique_districts.append(d)
DISTRICTS = unique_districts

def bbox_to_polygon(bbox):
    """Convert bbox to a simple polygon."""
    w, s, e, n = bbox
    return {
        "type": "Polygon",
        "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]
    }

def main():
    # Load hazard rasters
    haz_path = "data/tamil_nadu/hazards.png"
    aux_path = "data/tamil_nadu/aux_layers.png"
    
    if not os.path.exists(haz_path):
        print("hazards.png not found, run generate_synthetic.py first")
        return
    
    haz_img = np.array(Image.open(haz_path))
    aux_img = np.array(Image.open(aux_path))
    h, w = haz_img.shape[:2]
    
    BBOX_REGION = [76.2, 8.0, 80.4, 13.6]
    west, south, east, north = BBOX_REGION
    
    # AHP weights
    AHP_MATRIX = np.array([
        [1, 1, 2, 3],
        [1, 1, 2, 3],
        [1/2, 1/2, 1, 2],
        [1/3, 1/3, 1/2, 1],
    ])
    eigenvalues, eigenvectors = np.linalg.eig(AHP_MATRIX)
    max_idx = np.argmax(eigenvalues.real)
    weights_arr = eigenvectors[:, max_idx].real
    weights_arr = weights_arr / weights_arr.sum()
    w_flood, w_landslide, w_slope, w_exposure = weights_arr
    
    features = []
    for d in DISTRICTS:
        db = d["bbox"]
        # Convert to pixels
        px_w = int((db[0] - west) / (east - west) * w)
        px_e = int((db[2] - west) / (east - west) * w)
        px_n = int((1 - (db[3] - south) / (north - south)) * h)
        px_s = int((1 - (db[1] - south) / (north - south)) * h)
        
        px_w = max(0, min(w - 1, px_w))
        px_e = max(0, min(w - 1, px_e))
        px_n = max(0, min(h - 1, px_n))
        px_s = max(0, min(h - 1, px_s))
        
        if px_e <= px_w or px_s <= px_n:
            continue
        
        region_haz = haz_img[px_n:px_s, px_w:px_e]
        region_aux = aux_img[px_n:px_s, px_w:px_e]
        
        land = region_aux[:, :, 1] > 127
        n_land = np.sum(land)
        if n_land < 5:
            continue
        
        mean_flood = float(np.mean(region_haz[:, :, 0][land]) / 255)
        mean_landslide = float(np.mean(region_haz[:, :, 1][land]) / 255)
        mean_slope = float(np.mean(region_haz[:, :, 2][land]) / 255)
        mean_exposure = float(np.mean(region_aux[:, :, 0][land]) / 255)
        
        composite = (
            mean_flood * w_flood +
            mean_landslide * w_landslide +
            mean_slope * w_slope +
            mean_exposure * w_exposure
        )
        
        if composite < 0.2: risk_class = "very_low"
        elif composite < 0.4: risk_class = "low"
        elif composite < 0.6: risk_class = "moderate"
        elif composite < 0.8: risk_class = "high"
        else: risk_class = "very_high"
        
        features.append({
            "type": "Feature",
            "geometry": bbox_to_polygon(d["bbox"]),
            "properties": {
                "name": d["name"],
                "mean_flood": round(mean_flood, 4),
                "mean_landslide": round(mean_landslide, 4),
                "mean_slope": round(mean_slope, 4),
                "mean_exposure": round(mean_exposure, 4),
                "composite_risk": round(composite, 4),
                "risk_class": risk_class,
                "pixel_count": int(n_land),
            }
        })
        print(f"  {d['name']}: risk={composite:.3f} ({risk_class})")
    
    features.sort(key=lambda f: f["properties"]["composite_risk"], reverse=True)
    
    geojson = {
        "type": "FeatureCollection",
        "features": features
    }
    
    out_path = "data/tamil_nadu/districts.geojson"
    with open(out_path, "w") as f:
        json.dump(geojson, f)
    
    size_kb = os.path.getsize(out_path) / 1024
    print(f"\ndistricts.geojson: {len(features)} districts, {size_kb:.1f} KB")
    
    # Update meta.json
    meta_path = "data/tamil_nadu/meta.json"
    with open(meta_path) as f:
        meta = json.load(f)
    meta["districts"] = {
        "count": len(features),
        "boundary_source": "Approximate centroids/bboxes (use GEE pipeline for GAUL boundaries)",
        "top5_risk": [
            {"name": f["properties"]["name"], "risk": f["properties"]["composite_risk"]}
            for f in features[:5]
        ]
    }
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print("meta.json updated")

if __name__ == "__main__":
    main()
