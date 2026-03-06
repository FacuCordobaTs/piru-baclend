/**
 * Point-in-Polygon detection using the Ray-casting algorithm.
 * 
 * Determines whether a given (lat, lng) point lies inside a polygon
 * defined by an array of {lat, lng} coordinates.
 * 
 * Algorithm: Cast a horizontal ray from the point to the right.
 * If it crosses an odd number of polygon edges, the point is inside.
 */

interface Coord {
    lat: number
    lng: number
}

export function pointInPolygon(point: Coord, polygon: Coord[]): boolean {
    if (!polygon || polygon.length < 3) return false

    let inside = false
    const n = polygon.length

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i].lat
        const yi = polygon[i].lng
        const xj = polygon[j].lat
        const yj = polygon[j].lng

        const intersect =
            (yi > point.lng) !== (yj > point.lng) &&
            point.lat < ((xj - xi) * (point.lng - yi)) / (yj - yi) + xi

        if (intersect) inside = !inside
    }

    return inside
}

/**
 * Given a point and an array of zones, find the first zone where the point falls inside.
 * Returns the matching zone or null if none matches.
 */
export function findZoneForPoint<T extends { poligono: Coord[] | any }>(
    point: Coord,
    zones: T[]
): T | null {
    for (const zone of zones) {
        // poligono may come as a JSON string from the DB
        const polygon: Coord[] = typeof zone.poligono === 'string'
            ? JSON.parse(zone.poligono)
            : zone.poligono

        if (Array.isArray(polygon) && pointInPolygon(point, polygon)) {
            return zone
        }
    }
    return null
}
