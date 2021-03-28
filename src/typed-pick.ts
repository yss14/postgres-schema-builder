import { pick } from "lodash"

export const typedPick = <O, T extends keyof O>(obj: O, ...keys: T[]): Pick<O, T> => pick(obj, keys) as Pick<O, T>
