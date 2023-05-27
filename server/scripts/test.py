import sys

def funny_transform(input_string):
    # Reverse the input string
    reversed_string = input_string[::-1]
    
    # Add a funny message
    output_string = reversed_string + " ...and that's your input, but backwards! Funny, huh?"

    return output_string

if __name__ == "__main__":
    # Get the input string from the command line arguments
    input_string = sys.argv[1]

    # Call the funny_transform function
    output_string = funny_transform(input_string)

    # Print the output string
    print(output_string)
