'use client';

import { cloneElement, type ReactElement } from 'react';
import { useFormContext, type FieldPath, type FieldValues } from 'react-hook-form';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

interface FormFieldWrapperProps<TFieldValues extends FieldValues = FieldValues> {
  name: FieldPath<TFieldValues>;
  label?: string;
  required?: boolean;
  description?: string;
  children: ReactElement;
}

/** Wraps Controller + FormItem/FormLabel/FormControl/FormMessage boilerplate — used to reduce repetition in every form. */
export function FormFieldWrapper<TFieldValues extends FieldValues = FieldValues>({
  name,
  label,
  required,
  description,
  children,
}: FormFieldWrapperProps<TFieldValues>) {
  const { control } = useFormContext<TFieldValues>();

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          {label && (
            <FormLabel>
              {label}
              {required && <span className="ml-0.5 text-destructive">*</span>}
            </FormLabel>
          )}
          <FormControl>{cloneElement(children, field)}</FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
