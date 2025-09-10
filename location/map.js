// Minimal polygon constraint. If you don't have corridor polygons yet,
// we fall back to a permissive bounding box around your graph nodes.
export class MapMatcher {
  constructor({ polygons = [], fallbackBBox = null } = {}) {
    this.polys = polygons;
    this.bbox = fallbackBBox; // {minX,minY,maxX,maxY}
  }
  isInside = (x,y) => {
    for (const poly of this.polys) if (pip(x,y,poly)) return true;
    if (!this.polys.length && this.bbox) {
      const {minX,minY,maxX,maxY} = this.bbox; return x>=minX && x<=maxX && y>=minY && y<=maxY;
    }
    return true; // permissive if nothing provided
  };
}
function pip(x,y,pts){ let inside=false; for(let i=0,j=pts.length-1;i<pts.length;j=i++){
  const xi=pts[i][0], yi=pts[i][1], xj=pts[j][0], yj=pts[j][1];
  const inter = (yi>y)!==(yj>y) && x < ((xj-xi)*(y-yi))/(yj-yi+1e-12) + xi;
  if (inter) inside = !inside;
} return inside; }

