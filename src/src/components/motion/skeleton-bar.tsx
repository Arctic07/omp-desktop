import { motion } from 'motion/react'

import { cn } from '@/lib/utils'

/** One skeleton bar: the app's wait, drawn with the same motion system as every beUI surface. */
export function SkeletonBar({
  className,
  delay = 0,
}: {
  className: string
  delay?: number
}) {
  return (
    <motion.div
      aria-hidden="true"
      className={cn('rounded-md bg-muted', className)}
      animate={{ opacity: [0.45, 0.9, 0.45] }}
      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut', delay }}
    />
  )
}
