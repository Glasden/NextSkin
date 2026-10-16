import { useEffect } from 'react'

export default function EffectThrow() {
  useEffect(() => {
    throw new Error('effect-throw: effect 里出错')
  }, [])
  return <p>effect-throw</p>
}
