import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

const buttonVariants = cva('inline-flex items-center justify-center', {
  variants: {
    variant: {
      default: 'bg-slate-900 text-white',
      outline: 'border border-slate-200 bg-white text-slate-900',
    },
  },
  defaultVariants: { variant: 'default' },
})

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, asChild = false, ...props }, ref) => {
    const Component = asChild ? Slot : 'button'
    return <Component className={cn(buttonVariants({ variant }), className)} ref={ref} {...props} />
  },
)
Button.displayName = 'Button'

export { Button }
