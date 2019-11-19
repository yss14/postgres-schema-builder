export const flatten = <T>(arr: T[][]): T[] => arr.reduce((acc, value) => acc.concat(value), [])
